import pkg from 'pg';
import { DATABASE_URL } from './config.js';

const { Pool } = pkg;

if (!DATABASE_URL) {
  console.error('\n❌ ERROR: DATABASE_URL is not set in your .env file.');
  console.error('Please set DATABASE_URL in backend/.env');
  console.error('Example: DATABASE_URL=postgres://user:password@localhost:5432/prime_orders\n');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  // Add connection timeout and retry logic
  connectionTimeoutMillis: 5000
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

export async function initDb() {
  let client;
  try {
    client = await pool.connect();
    console.log('✅ Connected to PostgreSQL database');
    
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
    console.log('✅ Database table "orders" ready');
    
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
    console.log('✅ Database table "product_shipping_defaults" ready');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('\n❌ ERROR: Cannot connect to PostgreSQL database.');
      console.error('The database server is not running or not accessible.');
      console.error('\nTroubleshooting steps:');
      console.error('1. Make sure PostgreSQL is installed and running');
      console.error('2. Check your DATABASE_URL connection string in backend/.env');
      console.error('3. Verify PostgreSQL is listening on the correct host/port');
      console.error('4. If using WSL, ensure PostgreSQL is running in WSL, not Windows');
      console.error(`\nCurrent DATABASE_URL: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}\n`);
    } else {
      console.error('Database initialization error:', err.message);
    }
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

