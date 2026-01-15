import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { PORT } from './config.js';
import { initDb, pool } from './db.js';
import { fetchUnshippedPrimeOrdersWithItems, buyLabel, gunzipBase64Zpl } from './amazonClient.js';

// Extract ZPL injection logic into reusable function
function injectSkuToZpl(originalZpl, sku, quantity) {
  const skuText = sku || 'UNKNOWN';
  const qtyText = quantity || 1;

  const injectionBlock = [
    '^FO50,1100^GB700,60,3^FS',
    `^FO50,1120^A0N,30,30^FD SKU: ${skuText}  QTY: ${qtyText}^FS`
  ].join('\n');

  // Inject block immediately before ^XZ
  const marker = '^XZ';
  const idx = originalZpl.lastIndexOf(marker);
  let modifiedZpl;

  if (idx === -1) {
    modifiedZpl = `${originalZpl.trim()}\n${injectionBlock}\n${marker}\n`;
  } else {
    modifiedZpl =
      originalZpl.slice(0, idx) +
      injectionBlock +
      '\n' +
      originalZpl.slice(idx);
  }

  return modifiedZpl;
}

const app = express();

app.use(cors());
app.use(bodyParser.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Get shipping defaults for a SKU
app.get('/api/shipping-defaults/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    if (!sku) {
      return res.status(400).json({ error: 'SKU is required.' });
    }

    const result = await pool.query(
      'SELECT weight_value, weight_unit, length, width, height, dimension_unit FROM product_shipping_defaults WHERE sku = $1',
      [sku]
    );

    if (result.rowCount === 0) {
      return res.json(null); // Return null if no defaults found
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching shipping defaults', err);
    res.status(500).json({ error: 'Failed to fetch shipping defaults.' });
  }
});

// List orders from DB
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT amazon_order_id, purchase_date, customer_name, shipping_address, items, is_prime, status, tracking_id FROM orders ORDER BY purchase_date DESC NULLS LAST'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching orders from DB', err);
    res.status(500).json({ error: 'Failed to fetch orders from database.' });
  }
});

// Sync Logic (/api/sync-orders)
app.post('/api/sync-orders', async (req, res) => {
  try {
    const orders = await fetchUnshippedPrimeOrdersWithItems();

    let inserted = 0;
    let updated = 0;
    for (const order of orders) {
      const {
        amazon_order_id,
        purchase_date,
        customer_name,
        shipping_address,
        items,
        is_prime,
        status
      } = order;

      // Check if order already exists and its current status
      const existingResult = await pool.query(
        'SELECT status FROM orders WHERE amazon_order_id = $1',
        [amazon_order_id]
      );

      if (existingResult.rowCount === 0) {
        // Insert new order
        const result = await pool.query(
          `
            INSERT INTO orders
            (amazon_order_id, purchase_date, customer_name, shipping_address, items, is_prime, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            amazon_order_id,
            purchase_date ? new Date(purchase_date) : null,
            customer_name,
            shipping_address,
            JSON.stringify(items || []),
            is_prime,
            status || 'Unshipped'
          ]
        );

        if (result.rowCount === 1) {
          inserted += 1;
        }
      } else {
        // Order exists - only update if it's not already 'LabelBought'
        const existingStatus = existingResult.rows[0].status;
        if (existingStatus !== 'LabelBought') {
          // Update order but preserve status if it's already 'LabelBought' in DB
          await pool.query(
            `
              UPDATE orders
              SET purchase_date = $1,
                  customer_name = $2,
                  shipping_address = $3,
                  items = $4,
                  is_prime = $5,
                  status = COALESCE($6, 'Unshipped')
              WHERE amazon_order_id = $7 AND status != 'LabelBought'
            `,
            [
              purchase_date ? new Date(purchase_date) : null,
              customer_name,
              shipping_address,
              JSON.stringify(items || []),
              is_prime,
              status || 'Unshipped',
              amazon_order_id
            ]
          );
          updated += 1;
        }
      }
    }

    res.json({ synced: orders.length, inserted, updated });
  } catch (err) {
    console.error('Error syncing orders', err);
    res.status(500).json({ error: 'Failed to sync orders from Amazon.' });
  }
});

// Buy Label Logic (/api/buy-label)
app.post('/api/buy-label', async (req, res) => {
  const { amazon_order_id, weight, dimensions } = req.body || {};

  if (!amazon_order_id || !weight || !dimensions) {
    return res.status(400).json({ error: 'amazon_order_id, weight, and dimensions are required.' });
  }

  try {
    // Get SKU/Qty from DB
    const orderResult = await pool.query(
      'SELECT items FROM orders WHERE amazon_order_id = $1',
      [amazon_order_id]
    );

    if (orderResult.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found in local database.' });
    }

    const items = orderResult.rows[0].items || [];
    const firstItem = items[0] || { sku: 'UNKNOWN', quantity: 1 };

    // Step A & B via amazonClient
    const { labelGzipped, sku, quantity, trackingId } = await buyLabel({
      amazon_order_id,
      weight,
      dimensions,
      sku: firstItem.sku,
      quantity: firstItem.quantity
    });

    // Step C1: Decode (Gunzip)
    const originalZpl = gunzipBase64Zpl(labelGzipped);

    // Use the extracted injection function
    const modifiedZpl = injectSkuToZpl(originalZpl, sku || firstItem.sku, quantity || firstItem.quantity);

    // Update order status to 'LabelBought', save tracking_id, and save the modified ZPL
    await pool.query(
      'UPDATE orders SET status = $1, tracking_id = $2, label_zpl = $3 WHERE amazon_order_id = $4',
      ['LabelBought', trackingId || null, modifiedZpl, amazon_order_id]
    );

    // Smart Weight Learning: Save shipping defaults if order has exactly 1 distinct SKU
    const itemsArray = Array.isArray(items) ? items : [];
    const distinctSkus = new Set(itemsArray.map(item => item?.sku).filter(Boolean));
    if (distinctSkus.size === 1) {
      const sku = Array.from(distinctSkus)[0];
      // UPSERT shipping defaults for this SKU
      await pool.query(
        `INSERT INTO product_shipping_defaults 
         (sku, weight_value, weight_unit, length, width, height, dimension_unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sku) 
         DO UPDATE SET 
           weight_value = EXCLUDED.weight_value,
           weight_unit = EXCLUDED.weight_unit,
           length = EXCLUDED.length,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           dimension_unit = EXCLUDED.dimension_unit`,
        [
          sku,
          weight.value,
          weight.unit,
          dimensions.length,
          dimensions.width,
          dimensions.height,
          dimensions.unit
        ]
      );
    }

    // Return modified ZPL (JSON so the frontend can download easily)
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      amazon_order_id,
      zpl: modifiedZpl,
      trackingId: trackingId || null
    });
  } catch (err) {
    console.error('Error buying label', err);
    res.status(500).json({ error: 'Failed to buy label from Amazon.' });
  }
});

// Bulk Buy Labels Logic (/api/bulk-buy-labels)
app.post('/api/bulk-buy-labels', async (req, res) => {
  const { amazon_order_ids, weight, dimensions } = req.body || {};

  if (!amazon_order_ids || !Array.isArray(amazon_order_ids) || amazon_order_ids.length === 0) {
    return res.status(400).json({ error: 'amazon_order_ids array is required and must not be empty.' });
  }

  if (!weight || !dimensions) {
    return res.status(400).json({ error: 'weight and dimensions are required.' });
  }

  const results = {
    succeeded: [],
    failed: [],
    combinedZpl: ''
  };

  // Process each order
  for (const amazon_order_id of amazon_order_ids) {
    try {
      // Get SKU/Qty from DB
      const orderResult = await pool.query(
        'SELECT items FROM orders WHERE amazon_order_id = $1',
        [amazon_order_id]
      );

      if (orderResult.rowCount === 0) {
        results.failed.push({
          amazon_order_id,
          error: 'Order not found in local database.'
        });
        continue;
      }

      const items = orderResult.rows[0].items || [];
      const firstItem = items[0] || { sku: 'UNKNOWN', quantity: 1 };

      // Buy label via amazonClient
      const { labelGzipped, sku, quantity, trackingId } = await buyLabel({
        amazon_order_id,
        weight,
        dimensions,
        sku: firstItem.sku,
        quantity: firstItem.quantity
      });

      // Decode (Gunzip)
      const originalZpl = gunzipBase64Zpl(labelGzipped);

      // Inject SKU/Qty metadata
      const modifiedZpl = injectSkuToZpl(originalZpl, sku || firstItem.sku, quantity || firstItem.quantity);

      // Append to combined ZPL (add newline between labels)
      if (results.combinedZpl) {
        results.combinedZpl += '\n';
      }
      results.combinedZpl += modifiedZpl;

      // Update order status to 'LabelBought', save tracking_id, and save the modified ZPL
      await pool.query(
        'UPDATE orders SET status = $1, tracking_id = $2, label_zpl = $3 WHERE amazon_order_id = $4',
        ['LabelBought', trackingId || null, modifiedZpl, amazon_order_id]
      );

      results.succeeded.push({
        amazon_order_id,
        trackingId: trackingId || null
      });
    } catch (err) {
      console.error(`Error processing order ${amazon_order_id}:`, err);
      results.failed.push({
        amazon_order_id,
        error: err.message || String(err)
      });
      // Continue to next order instead of stopping
    }
  }

  // Return results with combined ZPL
  res.json({
    succeeded: results.succeeded,
    failed: results.failed,
    zpl: results.combinedZpl,
    summary: {
      total: amazon_order_ids.length,
      succeeded: results.succeeded.length,
      failed: results.failed.length
    }
  });
});

// Reprint Label Logic (GET /api/reprint/:orderId)
app.get('/api/reprint/:orderId', async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res.status(400).json({ error: 'Order ID is required.' });
  }

  try {
    // Query database for saved ZPL
    const result = await pool.query(
      'SELECT label_zpl, amazon_order_id FROM orders WHERE amazon_order_id = $1',
      [orderId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found in database.' });
    }

    const labelZpl = result.rows[0].label_zpl;

    if (!labelZpl) {
      return res.status(404).json({ error: 'No saved label found for this order. Label may not have been purchased yet.' });
    }

    // Return ZPL as downloadable file
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${orderId}.zpl"`);
    res.send(labelZpl);
  } catch (err) {
    console.error('Error reprinting label', err);
    res.status(500).json({ error: 'Failed to reprint label.' });
  }
});

// Bulk Reprint Labels Logic (POST /api/bulk-reprint)
app.post('/api/bulk-reprint', async (req, res) => {
  const { amazon_order_ids } = req.body || {};

  if (!amazon_order_ids || !Array.isArray(amazon_order_ids) || amazon_order_ids.length === 0) {
    return res.status(400).json({ error: 'amazon_order_ids array is required and must not be empty.' });
  }

  const results = {
    succeeded: [],
    failed: [],
    combinedZpl: ''
  };

  // Process each order
  for (const amazon_order_id of amazon_order_ids) {
    try {
      // Query database for saved ZPL
      const result = await pool.query(
        'SELECT label_zpl FROM orders WHERE amazon_order_id = $1',
        [amazon_order_id]
      );

      if (result.rowCount === 0) {
        results.failed.push({
          amazon_order_id,
          error: 'Order not found in database.'
        });
        continue;
      }

      const labelZpl = result.rows[0].label_zpl;

      if (!labelZpl) {
        results.failed.push({
          amazon_order_id,
          error: 'No saved label found for this order.'
        });
        continue;
      }

      // Append to combined ZPL (add newline between labels)
      if (results.combinedZpl) {
        results.combinedZpl += '\n';
      }
      results.combinedZpl += labelZpl;

      results.succeeded.push({
        amazon_order_id
      });
    } catch (err) {
      console.error(`Error processing reprint for order ${amazon_order_id}:`, err);
      results.failed.push({
        amazon_order_id,
        error: err.message || String(err)
      });
    }
  }

  // Return results with combined ZPL
  res.json({
    succeeded: results.succeeded,
    failed: results.failed,
    zpl: results.combinedZpl,
    summary: {
      total: amazon_order_ids.length,
      succeeded: results.succeeded.length,
      failed: results.failed.length
    }
  });
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Backend API listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
  }
}

start();

