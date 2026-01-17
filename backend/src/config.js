import dotenv from 'dotenv';
import { logger } from './logger.js';

dotenv.config();

export const PORT = process.env.PORT || 4000;

export const DATABASE_URL = process.env.DATABASE_URL;

export const USE_MOCK = String(process.env.USE_MOCK).toLowerCase() === 'true';

export const SHIP_FROM_ADDRESS = {
  Name: process.env.SHIP_FROM_NAME || 'Your Warehouse Name',
  AddressLine1: process.env.SHIP_FROM_ADDRESS_LINE1 || '123 Example Street',
  AddressLine2: process.env.SHIP_FROM_ADDRESS_LINE2 || '',
  City: process.env.SHIP_FROM_CITY || 'City',
  StateOrProvinceCode: process.env.SHIP_FROM_STATE || 'RM',
  PostalCode: process.env.SHIP_FROM_POSTAL_CODE || '00100',
  CountryCode: process.env.SHIP_FROM_COUNTRY || 'IT',
  PhoneNumber: process.env.SHIP_FROM_PHONE || '0000000000'
};

export const AMAZON_CONFIG = {
  sellerId: process.env.SELLER_ID,
  lwaClientId: process.env.LWA_CLIENT_ID,
  lwaClientSecret: process.env.LWA_CLIENT_SECRET,
  refreshToken: process.env.REFRESH_TOKEN,
  region: process.env.SP_API_REGION || 'eu-west-1',
  marketplaceId: process.env.MARKETPLACE_ID || 'APJ6JRA9NG5V4', // Italy marketplace ID
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  roleArn: process.env.AWS_SELLING_PARTNER_ROLE_ARN
};

function parseBoolean(value, defaultValue) {
  if (typeof value !== 'string') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePositiveInt(value, defaultValue) {
  if (typeof value !== 'string') {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseNonNegativeInt(value, defaultValue) {
  if (typeof value !== 'string') {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const RATE_LIMIT_ENABLED = parseBoolean(
  process.env.RATE_LIMIT_ENABLED,
  process.env.NODE_ENV !== 'development'
);

export const RATE_LIMIT_SYNC_MAX = parsePositiveInt(process.env.RATE_LIMIT_SYNC_MAX, 10);
export const RATE_LIMIT_SYNC_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_SYNC_WINDOW_MS, HOUR_MS);

export const RATE_LIMIT_LABEL_MAX = parsePositiveInt(process.env.RATE_LIMIT_LABEL_MAX, 30);
export const RATE_LIMIT_LABEL_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_LABEL_WINDOW_MS, HOUR_MS);

export const RATE_LIMIT_READ_MAX = parsePositiveInt(process.env.RATE_LIMIT_READ_MAX, 100);
export const RATE_LIMIT_READ_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_READ_WINDOW_MS, MINUTE_MS);

export const ZPL_INJECT_X = parseNonNegativeInt(process.env.ZPL_INJECT_X, 50);
export const ZPL_INJECT_Y = parseNonNegativeInt(process.env.ZPL_INJECT_Y, 1100);

function isValidPostgresUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch (error) {
    return false;
  }
}

export function validateEnvironment() {
  const missing = [];
  const invalid = [];

  if (!process.env.DATABASE_URL) {
    missing.push('DATABASE_URL');
  } else if (!isValidPostgresUrl(process.env.DATABASE_URL)) {
    invalid.push('DATABASE_URL (expected postgres:// URL)');
  }

  if (!USE_MOCK) {
    const amazonVars = [
      'SELLER_ID',
      'LWA_CLIENT_ID',
      'LWA_CLIENT_SECRET',
      'REFRESH_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SELLING_PARTNER_ROLE_ARN'
    ];
    amazonVars.forEach((key) => {
      if (!process.env[key]) {
        missing.push(key);
      }
    });
  }

  if (missing.length || invalid.length) {
    const issues = [];
    if (missing.length) {
      issues.push(`Missing: ${missing.join(', ')}`);
    }
    if (invalid.length) {
      issues.push(`Invalid: ${invalid.join(', ')}`);
    }
    logger.error('Environment validation failed', {
      operation: 'validateEnvironment',
      missing,
      invalid
    });
    process.stderr.write(`${issues.join(' | ')}\n`);
    process.exit(1);
  }
}
