import pkg from 'pg';
import { DATABASE_URL } from './config.js';
import { logger } from './logger.js';

const { Pool } = pkg;

function maskDatabaseUrl(url) {
  if (typeof url !== 'string') {
    return url;
  }
  return url.replace(/:[^:@]+@/, ':****@');
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  // Add connection timeout and retry logic
  connectionTimeoutMillis: 5000
});

// Handle pool errors
pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', {
    operation: 'db.pool.error',
    error: err
  });
});

export async function initDb() {
  let client;
  try {
    client = await pool.connect();
    logger.info('Connected to PostgreSQL database', {
      operation: 'db.connect'
    });
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        amazon_order_id VARCHAR PRIMARY KEY,
        purchase_date TIMESTAMP,
        customer_name VARCHAR,
        shipping_address JSONB,
        items JSONB,
        is_prime BOOLEAN,
        status VARCHAR DEFAULT 'Unshipped',
        tracking_id VARCHAR
      )
    `);
    
    // Add tracking_id column if it doesn't exist (for existing databases)
    await client.query(`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS tracking_id VARCHAR
    `);
    
    // Add label_zpl column if it doesn't exist (for saving purchased ZPL labels)
    await client.query(`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS label_zpl TEXT
    `);
    logger.info('Database table "orders" ready', {
      operation: 'db.migrate.orders'
    });
    
    // Create product_shipping_defaults table for Smart Weight feature
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_shipping_defaults (
        sku VARCHAR PRIMARY KEY,
        weight_value DECIMAL,
        weight_unit VARCHAR,
        length DECIMAL,
        width DECIMAL,
        height DECIMAL,
        dimension_unit VARCHAR
      )
    `);
    logger.info('Database table "product_shipping_defaults" ready', {
      operation: 'db.migrate.product_shipping_defaults'
    });
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      logger.error('Cannot connect to PostgreSQL database', {
        operation: 'db.connect',
        error: err,
        hints: [
          'Make sure PostgreSQL is installed and running',
          'Check DATABASE_URL in backend/.env',
          'Verify PostgreSQL is listening on the correct host/port',
          'If using WSL, ensure PostgreSQL is running in WSL, not Windows'
        ],
        databaseUrl: maskDatabaseUrl(DATABASE_URL)
      });
    } else {
      logger.error('Database initialization error', {
        operation: 'db.init',
        error: err
      });
    }
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

