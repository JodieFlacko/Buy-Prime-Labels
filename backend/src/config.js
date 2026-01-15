import dotenv from 'dotenv';

dotenv.config();

export const PORT = process.env.PORT || 4000;

export const DATABASE_URL = process.env.DATABASE_URL;

export const USE_MOCK = String(process.env.USE_MOCK).toLowerCase() === 'true';

export const SHIP_FROM_ADDRESS = {
  name: process.env.SHIP_FROM_NAME || 'Your Warehouse Name',
  addressLine1: process.env.SHIP_FROM_ADDRESS_LINE1 || '123 Example Street',
  addressLine2: process.env.SHIP_FROM_ADDRESS_LINE2 || '',
  city: process.env.SHIP_FROM_CITY || 'City',
  stateOrRegion: process.env.SHIP_FROM_STATE || 'RM',
  postalCode: process.env.SHIP_FROM_POSTAL_CODE || '00100',
  countryCode: process.env.SHIP_FROM_COUNTRY || 'IT',
  phone: process.env.SHIP_FROM_PHONE || '0000000000'
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

