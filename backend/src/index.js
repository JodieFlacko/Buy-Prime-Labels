import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { PORT, ZPL_INJECT_X, ZPL_INJECT_Y, validateEnvironment } from './config.js';
import { initDb, pool } from './db.js';
import { fetchUnshippedPrimeOrdersWithItems, buyLabel, gunzipBase64Zpl } from './amazonClient.js';
import {
  labelLimiter,
  rateLimitEnabled,
  readLimiter,
  syncLimiter
} from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler, registerProcessHandlers } from './middleware/errorHandler.js';
import { logger } from './logger.js';

const ZPL_INJECT_BOX_WIDTH = 700;
const ZPL_INJECT_BOX_HEIGHT = 60;
const ZPL_MAX_SKU_LENGTH = 20;

function parseZplNumber(field, zpl) {
  const match = zpl.match(new RegExp(`\\^${field}(\\d+)`, 'i'));
  return match ? Number.parseInt(match[1], 10) : null;
}

function countOccurrences(haystack, needle) {
  if (!needle) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

/**
 * Validate minimal ZPL structure.
 * - Ensures required ^XA (start) and ^XZ (end) markers exist and are ordered.
 * - Flags suspicious patterns such as multiple headers/footers or missing size hints.
 * - Returns errors for invalid structure and warnings for non-fatal anomalies.
 * @param {string} zpl - Raw ZPL string.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], meta: { startIndex: number, endIndex: number, printWidth: number|null, labelLength: number|null } }}
 */
export function validateZpl(zpl) {
  const errors = [];
  const warnings = [];

  if (typeof zpl !== 'string' || !zpl.trim()) {
    errors.push('ZPL payload is empty.');
    return {
      ok: false,
      errors,
      warnings,
      meta: { startIndex: -1, endIndex: -1, printWidth: null, labelLength: null }
    };
  }

  const startIndex = zpl.indexOf('^XA');
  const endIndex = zpl.lastIndexOf('^XZ');

  if (startIndex === -1) {
    errors.push('Missing ^XA start marker.');
  }
  if (endIndex === -1) {
    errors.push('Missing ^XZ end marker.');
  }
  if (startIndex !== -1 && endIndex !== -1 && endIndex < startIndex) {
    errors.push('^XZ end marker appears before ^XA start marker.');
  }

  const xaCount = countOccurrences(zpl, '^XA');
  const xzCount = countOccurrences(zpl, '^XZ');
  if (xaCount > 1) {
    warnings.push('Multiple ^XA markers detected.');
  }
  if (xzCount > 1) {
    warnings.push('Multiple ^XZ markers detected.');
  }
  if (endIndex !== -1 && endIndex < zpl.length - 2) {
    warnings.push('Trailing content detected after final ^XZ marker.');
  }

  const printWidth = parseZplNumber('PW', zpl);
  const labelLength = parseZplNumber('LL', zpl);
  if (printWidth === null) {
    warnings.push('Missing ^PW (print width) definition.');
  }
  if (labelLength === null) {
    warnings.push('Missing ^LL (label length) definition.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    meta: { startIndex, endIndex, printWidth, labelLength }
  };
}

function coerceOverride(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function truncateSku(skuText) {
  if (skuText.length <= ZPL_MAX_SKU_LENGTH) {
    return { value: skuText, truncated: false };
  }
  const trimmed = `${skuText.slice(0, ZPL_MAX_SKU_LENGTH - 3)}...`;
  return { value: trimmed, truncated: true };
}

/**
 * Inject SKU/QTY metadata into ZPL with safety checks.
 * - Validates ^XA/^XZ markers and basic structural integrity before mutation.
 * - Uses configured coordinates with optional overrides per request.
 * - Ensures injection stays within ^PW/^LL bounds when provided by the label.
 * - Truncates long SKU values (max 20 chars) to avoid ZPL overflow.
 * - Supports dry-run mode that validates without mutation.
 * @param {string} originalZpl - Source ZPL string.
 * @param {string} sku - SKU text (will be sanitized and truncated).
 * @param {number} quantity - Quantity to display.
 * @param {{ x?: number|string, y?: number|string, dryRun?: boolean }} [options]
 * @returns {{ success: boolean, zpl: string, error?: string }}
 */
function injectSkuToZpl(originalZpl, sku, quantity, options = {}) {
  const validation = validateZpl(originalZpl);
  if (!validation.ok) {
    const error = validation.errors.join(' ');
    logger.error('Invalid ZPL, injection skipped', {
      operation: 'zpl.inject.validate',
      error,
      warnings: validation.warnings
    });
    return { success: false, zpl: originalZpl, error };
  }

  if (validation.warnings.length) {
    logger.warn('Suspicious ZPL patterns detected', {
      operation: 'zpl.inject.validate',
      warnings: validation.warnings
    });
  }

  const overrideX = coerceOverride(options.x);
  const overrideY = coerceOverride(options.y);
  const injectX = overrideX ?? ZPL_INJECT_X;
  const injectY = overrideY ?? ZPL_INJECT_Y;

  const skuText = typeof sku === 'string' && sku.trim() ? sku.trim() : 'UNKNOWN';
  const qtyText = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  const { value: safeSkuText, truncated } = truncateSku(skuText);

  if (truncated) {
    logger.warn('SKU truncated for ZPL injection', {
      operation: 'zpl.inject.truncate',
      originalSku: skuText,
      truncatedSku: safeSkuText
    });
  }

  if (injectX < 0 || injectY < 0) {
    return { success: false, zpl: originalZpl, error: 'Injection coordinates must be non-negative.' };
  }

  if (validation.meta.printWidth !== null) {
    const maxX = injectX + ZPL_INJECT_BOX_WIDTH;
    if (maxX > validation.meta.printWidth) {
      return {
        success: false,
        zpl: originalZpl,
        error: `Injection exceeds label width (${maxX} > ${validation.meta.printWidth}).`
      };
    }
  }

  if (validation.meta.labelLength !== null) {
    const maxY = injectY + ZPL_INJECT_BOX_HEIGHT;
    if (maxY > validation.meta.labelLength) {
      return {
        success: false,
        zpl: originalZpl,
        error: `Injection exceeds label length (${maxY} > ${validation.meta.labelLength}).`
      };
    }
  }

  const injectionBlock = [
    `^FO${injectX},${injectY}^GB${ZPL_INJECT_BOX_WIDTH},${ZPL_INJECT_BOX_HEIGHT},3^FS`,
    `^FO${injectX},${injectY + 20}^A0N,30,30^FD SKU: ${safeSkuText}  QTY: ${qtyText}^FS`
  ].join('\n');

  if (options.dryRun) {
    return { success: true, zpl: originalZpl };
  }

  const marker = '^XZ';
  const idx = validation.meta.endIndex;
  const modifiedZpl =
    originalZpl.slice(0, idx) +
    injectionBlock +
    '\n' +
    originalZpl.slice(idx);

  const postValidation = validateZpl(modifiedZpl);
  if (!postValidation.ok) {
    const error = postValidation.errors.join(' ');
    logger.error('ZPL validation failed after injection', {
      operation: 'zpl.inject.postValidate',
      error,
      warnings: postValidation.warnings
    });
    return { success: false, zpl: originalZpl, error };
  }

  return { success: true, zpl: modifiedZpl };
}

function getZplInjectOptions(payload = {}) {
  const x = coerceOverride(payload.zpl_inject_x);
  const y = coerceOverride(payload.zpl_inject_y);
  const options = {};

  if (x !== null) {
    options.x = x;
  }
  if (y !== null) {
    options.y = y;
  }
  if (payload.zpl_inject_dry_run === true) {
    options.dryRun = true;
  }

  return options;
}

const WEIGHT_UNITS = new Set(['oz', 'lb', 'g', 'kg']);
const DIMENSION_UNITS = new Set(['in', 'cm']);
const MAX_WEIGHT_LB = 150;
const MIN_DIMENSION_IN = 0.1;
const MAX_DIMENSION_IN = 108;
const MAX_BULK_IDS = 50;

function normalizeNumber(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return NaN;
    }
    return Number(trimmed);
  }
  return NaN;
}

function toInches(value, unit) {
  return unit === 'cm' ? value / 2.54 : value;
}

function toPounds(value, unit) {
  if (unit === 'oz') {
    return value / 16;
  }
  if (unit === 'g') {
    return value / 453.59237;
  }
  if (unit === 'kg') {
    return value * 2.20462262;
  }
  return value;
}

function computeDimensionalWeightLb(length, width, height, unit) {
  if (unit === 'cm') {
    return (length * width * height) / 5000 * 2.20462262;
  }
  return (length * width * height) / 139;
}

/**
 * Validate label buying payloads for single and bulk requests.
 * @param {object} payload - Request payload inputs.
 * @param {string} [payload.amazon_order_id] - Single order id.
 * @param {string[]} [payload.amazon_order_ids] - Bulk order ids.
 * @param {object} payload.weight - Weight object with value and unit.
 * @param {object} payload.dimensions - Dimensions object with length, width, height, unit.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateLabelRequest(payload) {
  const errors = [];
  const warnings = [];

  const isBulk = Array.isArray(payload.amazon_order_ids);

  if (isBulk) {
    const ids = payload.amazon_order_ids;
    if (ids.length < 1 || ids.length > MAX_BULK_IDS) {
      errors.push(`amazon_order_ids must contain between 1 and ${MAX_BULK_IDS} order IDs.`);
    }
    ids.forEach((id, idx) => {
      if (typeof id !== 'string' || !id.trim()) {
        errors.push(`amazon_order_ids[${idx}] must be a non-empty string.`);
      }
    });
  } else {
    if (typeof payload.amazon_order_id !== 'string' || !payload.amazon_order_id.trim()) {
      errors.push('amazon_order_id must be a non-empty string.');
    }
  }

  const weight = payload.weight;
  if (!weight || typeof weight !== 'object') {
    errors.push('weight is required and must be an object.');
  } else {
    const weightValue = normalizeNumber(weight.value);
    const weightUnit = typeof weight.unit === 'string' ? weight.unit.trim() : '';
    if (!Number.isFinite(weightValue) || weightValue <= 0) {
      errors.push('weight.value must be a positive number.');
    }
    if (!WEIGHT_UNITS.has(weightUnit)) {
      errors.push(`weight.unit must be one of: ${Array.from(WEIGHT_UNITS).join(', ')}.`);
    }
    if (Number.isFinite(weightValue) && WEIGHT_UNITS.has(weightUnit)) {
      const weightLb = toPounds(weightValue, weightUnit);
      if (weightLb > MAX_WEIGHT_LB) {
        errors.push(`weight.value exceeds the ${MAX_WEIGHT_LB} lb limit.`);
      }
    }
  }

  const dimensions = payload.dimensions;
  if (!dimensions || typeof dimensions !== 'object') {
    errors.push('dimensions are required and must be an object.');
  } else {
    const lengthValue = normalizeNumber(dimensions.length);
    const widthValue = normalizeNumber(dimensions.width);
    const heightValue = normalizeNumber(dimensions.height);
    const dimensionUnit = typeof dimensions.unit === 'string' ? dimensions.unit.trim() : '';

    if (!Number.isFinite(lengthValue) || lengthValue <= 0) {
      errors.push('dimensions.length must be a positive number.');
    }
    if (!Number.isFinite(widthValue) || widthValue <= 0) {
      errors.push('dimensions.width must be a positive number.');
    }
    if (!Number.isFinite(heightValue) || heightValue <= 0) {
      errors.push('dimensions.height must be a positive number.');
    }
    if (!DIMENSION_UNITS.has(dimensionUnit)) {
      errors.push(`dimensions.unit must be one of: ${Array.from(DIMENSION_UNITS).join(', ')}.`);
    }

    if (
      Number.isFinite(lengthValue) &&
      Number.isFinite(widthValue) &&
      Number.isFinite(heightValue) &&
      DIMENSION_UNITS.has(dimensionUnit)
    ) {
      const lengthIn = toInches(lengthValue, dimensionUnit);
      const widthIn = toInches(widthValue, dimensionUnit);
      const heightIn = toInches(heightValue, dimensionUnit);
      const dimensionsIn = [
        { name: 'length', value: lengthIn },
        { name: 'width', value: widthIn },
        { name: 'height', value: heightIn }
      ];

      dimensionsIn.forEach(({ name, value }) => {
        if (value < MIN_DIMENSION_IN || value > MAX_DIMENSION_IN) {
          errors.push(`dimensions.${name} must be between ${MIN_DIMENSION_IN} and ${MAX_DIMENSION_IN} inches.`);
        }
      });

      const dimensionalWeight = computeDimensionalWeightLb(lengthValue, widthValue, heightValue, dimensionUnit);
      if (dimensionalWeight > MAX_WEIGHT_LB) {
        warnings.push(
          `Dimensional weight is ${dimensionalWeight.toFixed(2)} lb, which exceeds ${MAX_WEIGHT_LB} lb.`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

const app = express();

app.use(cors());
app.use(bodyParser.json());

registerProcessHandlers();

if (rateLimitEnabled) {
  app.use('/api/sync-orders', syncLimiter);
  app.use(['/api/buy-label', '/api/bulk-buy-labels'], labelLimiter);
  app.use(['/api/orders', '/api/health'], readLimiter);
}

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
    logger.error('Error fetching shipping defaults', {
      operation: 'shippingDefaults.fetch',
      input: { sku },
      error: err
    });
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
    logger.error('Error fetching orders from DB', {
      operation: 'orders.list',
      error: err
    });
    res.status(500).json({ error: 'Failed to fetch orders from database.' });
  }
});

// Sync Logic (/api/sync-orders)
app.post('/api/sync-orders', async (req, res) => {
  const client = await pool.connect();
  try {
    const orders = await fetchUnshippedPrimeOrdersWithItems();

    let inserted = 0;
    let updated = 0;

    await client.query('BEGIN');

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

      const result = await client.query(
        `
          INSERT INTO orders
          (amazon_order_id, purchase_date, customer_name, shipping_address, items, is_prime, status)
          VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'Unshipped'))
          ON CONFLICT (amazon_order_id)
          DO UPDATE SET
            purchase_date = EXCLUDED.purchase_date,
            customer_name = EXCLUDED.customer_name,
            shipping_address = EXCLUDED.shipping_address,
            items = EXCLUDED.items,
            is_prime = EXCLUDED.is_prime,
            status = EXCLUDED.status
          WHERE orders.status != 'LabelBought'
          RETURNING (xmax = 0) AS inserted
        `,
        [
          amazon_order_id,
          purchase_date ? new Date(purchase_date) : null,
          customer_name,
          shipping_address,
          JSON.stringify(items || []),
          is_prime,
          status
        ]
      );

      if (result.rowCount === 1) {
        if (result.rows[0].inserted) {
          inserted += 1;
        } else {
          updated += 1;
        }
      }
    }

    await client.query('COMMIT');

    res.json({ synced: orders.length, inserted, updated });
  } catch (err) {
    logger.error('Error syncing orders', {
      operation: 'orders.sync',
      error: err
    });
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Error rolling back sync-orders transaction', {
        operation: 'orders.sync.rollback',
        error: rollbackErr
      });
    }
    res.status(500).json({ error: 'Failed to sync orders from Amazon.' });
  } finally {
    client.release();
  }
});

// Buy Label Logic (/api/buy-label)
app.post('/api/buy-label', async (req, res) => {
  const { amazon_order_id, weight, dimensions } = req.body || {};
  const zplInjectOptions = getZplInjectOptions(req.body || {});

  const validation = validateLabelRequest({ amazon_order_id, weight, dimensions });
  if (!validation.ok) {
    return res.status(400).json({
      error: 'Invalid request.',
      details: validation.errors
    });
  }

  try {
    if (validation.warnings.length) {
      logger.warn('buy-label validation warnings', {
        operation: 'label.buy.validate',
        warnings: validation.warnings,
        input: { amazon_order_id, weight, dimensions }
      });
    }
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

    const injectionResult = injectSkuToZpl(
      originalZpl,
      sku || firstItem.sku,
      quantity || firstItem.quantity,
      zplInjectOptions
    );

    if (!injectionResult.success) {
      logger.error('ZPL injection failed for buy-label', {
        operation: 'label.buy.injectZpl',
        input: { amazon_order_id },
        error: injectionResult.error
      });
      return res.status(500).json({
        error: injectionResult.error || 'Failed to inject ZPL.'
      });
    }

    const modifiedZpl = injectionResult.zpl;

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
      trackingId: trackingId || null,
      warnings: validation.warnings.length ? validation.warnings : undefined,
      dryRun: zplInjectOptions.dryRun === true ? true : undefined
    });
  } catch (err) {
    logger.error('Error buying label', {
      operation: 'label.buy',
      input: { amazon_order_id, weight, dimensions },
      error: err
    });
    res.status(500).json({ error: 'Failed to buy label from Amazon.' });
  }
});

// Bulk Buy Labels Logic (/api/bulk-buy-labels)
app.post('/api/bulk-buy-labels', async (req, res) => {
  const { amazon_order_ids, weight, dimensions } = req.body || {};
  const zplInjectOptions = getZplInjectOptions(req.body || {});

  const validation = validateLabelRequest({ amazon_order_ids, weight, dimensions });
  if (!validation.ok) {
    return res.status(400).json({
      error: 'Invalid request.',
      details: validation.errors
    });
  }

  if (validation.warnings.length) {
    logger.warn('bulk-buy-labels validation warnings', {
      operation: 'label.bulkBuy.validate',
      warnings: validation.warnings,
      input: { amazon_order_ids, weight, dimensions }
    });
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

      const injectionResult = injectSkuToZpl(
        originalZpl,
        sku || firstItem.sku,
        quantity || firstItem.quantity,
        zplInjectOptions
      );

      if (!injectionResult.success) {
        results.failed.push({
          amazon_order_id,
          error: injectionResult.error || 'Failed to inject ZPL.'
        });
        continue;
      }

      const modifiedZpl = injectionResult.zpl;

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
      logger.error('Error processing order for bulk buy', {
        operation: 'label.bulkBuy.process',
        input: { amazon_order_id, weight, dimensions },
        error: err
      });
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
    warnings: validation.warnings.length ? validation.warnings : undefined,
    dryRun: zplInjectOptions.dryRun === true ? true : undefined,
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
    logger.error('Error reprinting label', {
      operation: 'label.reprint',
      input: { orderId },
      error: err
    });
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
      logger.error('Error processing reprint for order', {
        operation: 'label.bulkReprint.process',
        input: { amazon_order_id },
        error: err
      });
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

app.use(notFoundHandler);
app.use(errorHandler);

async function start() {
  try {
    validateEnvironment();
    await initDb();
    app.listen(PORT, () => {
      logger.info('Backend API listening', {
        operation: 'server.listen',
        port: PORT
      });
    });
  } catch (err) {
    logger.error('Failed to start server', {
      operation: 'server.start',
      error: err
    });
    process.exit(1);
  }
}

start();

