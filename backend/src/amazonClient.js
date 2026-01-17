import zlib from 'zlib';
import SellingPartnerAPI from 'amazon-sp-api';
import { AMAZON_CONFIG, SHIP_FROM_ADDRESS, USE_MOCK } from './config.js';
import { mockFetchUnshippedPrimeOrdersWithItems, mockGetOrderItems, mockBuyLabel } from './mock_api.js';
import { logger } from './logger.js';

const RETRYABLE_ERROR_CODES = new Set([
  'QuotaExceeded',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNABORTED',
  'ENETUNREACH'
]);

function getErrorStatus(error) {
  return error?.statusCode ?? error?.response?.status ?? error?.status ?? null;
}

function hasQuotaExceeded(error) {
  if (error?.code === 'QuotaExceeded') {
    return true;
  }

  const errorCode = error?.errors?.[0]?.code;
  if (errorCode === 'QuotaExceeded') {
    return true;
  }

  return typeof error?.message === 'string' && error.message.includes('QuotaExceeded');
}

function isNetworkTimeout(error) {
  if (error?.code && RETRYABLE_ERROR_CODES.has(error.code)) {
    return true;
  }

  return typeof error?.message === 'string' && error.message.toLowerCase().includes('timeout');
}

function isRetryableError(error) {
  const status = getErrorStatus(error);

  if (status === 503) {
    return true;
  }

  if (status && status >= 400) {
    return false;
  }

  return hasQuotaExceeded(error) || isNetworkTimeout(error);
}

async function retryWithBackoff(fn, { context, maxRetries = 3, baseDelayMs = 1000 } = {}) {
  let attempt = 0;
  let lastError;

  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error;
      }

      const retryNumber = attempt + 1;
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      const contextLabel = context ? ` for ${context}` : '';

      logger.warn('Retrying Amazon SP-API call', {
        operation: 'amazon.retry',
        context,
        retryNumber,
        maxRetries,
        delayMs,
        error
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }

  throw lastError;
}

async function createSpClient() {
  if (!AMAZON_CONFIG.sellerId || !AMAZON_CONFIG.lwaClientId) {
    throw new Error('Missing Amazon SP-API configuration in environment variables.');
  }

  const sp = new SellingPartnerAPI({
    region: AMAZON_CONFIG.region,
    refresh_token: AMAZON_CONFIG.refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: AMAZON_CONFIG.lwaClientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: AMAZON_CONFIG.lwaClientSecret,
      AWS_ACCESS_KEY_ID: AMAZON_CONFIG.awsAccessKeyId,
      AWS_SECRET_ACCESS_KEY: AMAZON_CONFIG.awsSecretAccessKey,
      AWS_SELLING_PARTNER_ROLE: AMAZON_CONFIG.roleArn
    },
    options: {
      auto_request_tokens: true,
      auto_request_throttled: true
    }
  });

  return sp;
}

export async function fetchUnshippedPrimeOrdersWithItems() {
  // Step 1: Create SP client if using real API (create once, reuse for all calls)
  const sp = USE_MOCK ? null : await createSpClient();

  // Step 2: Fetch orders from Amazon API (or mock)
  // Both return Amazon's format: { payload: { Orders: [...] } }
  let ordersResponse;
  
  if (USE_MOCK) {
    ordersResponse = await mockFetchUnshippedPrimeOrdersWithItems();
  } else {
    ordersResponse = await retryWithBackoff(
      () =>
        sp.callAPI({
          operation: 'getOrders',
          endpoint: 'orders',
          query: {
            MarketplaceIds: [AMAZON_CONFIG.marketplaceId].filter(Boolean),
            OrderStatuses: ['Unshipped'],
            FulfillmentChannels: ['MFN']
          }
        }),
      { context: 'getOrders' }
    );
  }

  // Step 3: Extract orders from payload wrapper (Amazon SP-API format)
  const orders = ordersResponse?.payload?.Orders || ordersResponse?.Orders || [];
  
  if (!orders.length) {
    logger.info('No unshipped orders found', { operation: 'fetchUnshippedPrimeOrdersWithItems' });
    return [];
  }

  // Step 4: Filter for Prime orders using Amazon's IsPrime field (PascalCase)
  const primeOrders = orders.filter((o) => o.IsPrime);

  // Step 5: Hydrate each Prime order with its items and transform to our format
  const hydrated = [];

  for (const order of primeOrders) {
    // Fetch order items from Amazon API (or mock)
    // Both return Amazon's format: { payload: { OrderItems: [...] } }
    let itemsResponse;
    
    if (USE_MOCK) {
      itemsResponse = await mockGetOrderItems(order.AmazonOrderId);
    } else {
      itemsResponse = await retryWithBackoff(
        () =>
          sp.callAPI({
            operation: 'getOrderItems',
            endpoint: 'orders',
            path: {
              orderId: order.AmazonOrderId
            }
          }),
        { context: `getOrderItems ${order.AmazonOrderId}` }
      );
    }

    // Extract order items from payload wrapper
    const orderItems = itemsResponse?.payload?.OrderItems || itemsResponse?.OrderItems || [];
    
    // Step 6: Transform Amazon's PascalCase fields to our snake_case database format
    // This transformation happens consistently for both mock and real API
    const items = orderItems.map((item) => ({
      sku: item.SellerSKU,           // PascalCase → snake_case
      quantity: item.QuantityOrdered  // PascalCase → snake_case
    }));

    hydrated.push({
      amazon_order_id: order.AmazonOrderId,                                            // PascalCase → snake_case
      purchase_date: order.PurchaseDate,                                               // PascalCase → snake_case
      customer_name: (order.ShippingAddress && order.ShippingAddress.Name) || 'Unknown', // Extract from nested object
      shipping_address: order.ShippingAddress || {},                                   // Keep the full address object
      items,                                                                           // Already transformed above
      is_prime: !!order.IsPrime,                                                       // PascalCase → snake_case
      status: order.OrderStatus || 'Unshipped'                                         // PascalCase → snake_case
    });
  }

  logger.info('Fetched Prime orders with items', { 
    operation: 'fetchUnshippedPrimeOrdersWithItems',
    totalOrders: orders.length,
    primeOrders: primeOrders.length
  });

  return hydrated;
}

export async function buyLabel({ amazon_order_id, weight, dimensions, sku, quantity }) {
  if (USE_MOCK) {
    return mockBuyLabel({ amazon_order_id, weight, dimensions });
  }

  const sp = await createSpClient();

  // Step A: getEligibleShipmentServices
  // Amazon SP-API returns: { payload: { ShippingServiceList: [...] } }
  const eligibleResponse = await retryWithBackoff(
    () =>
      sp.callAPI({
        operation: 'getEligibleShipmentServices',
        endpoint: 'merchantFulfillment',
        body: {
          ShipmentRequestDetails: {
            AmazonOrderId: amazon_order_id,
            ItemList: [
              {
                OrderItemId: amazon_order_id,
                Quantity: quantity || 1
              }
            ],
            ShipFromAddress: SHIP_FROM_ADDRESS,
            PackageDimensions: dimensions,
            Weight: weight,
            ShippingServiceOptions: {
              DeliveryExperience: 'DeliveryConfirmationWithoutSignature',
              CarrierWillPickUp: false,
              LabelFormat: 'ZPL203'
            }
          }
        }
      }),
    { context: `getEligibleShipmentServices ${amazon_order_id}` }
  );

  // Extract shipping services from payload wrapper
  const services = eligibleResponse?.payload?.ShippingServiceList || 
                   eligibleResponse?.ShippingServiceList || [];
  
  if (!services.length) {
    throw new Error('No eligible shipping services returned from Amazon.');
  }

  // Find cheapest eligible shipping service
  const cheapest = services.reduce((min, s) => {
    const cost = Number(s.ShippingServiceCost && s.ShippingServiceCost.Amount) || Infinity;
    return cost < min.cost ? { service: s, cost } : min;
  }, { service: services[0], cost: Number(services[0].ShippingServiceCost.Amount) || Infinity }).service;

  logger.info('Selected shipping service', {
    operation: 'buyLabel',
    amazon_order_id,
    serviceId: cheapest.ShippingServiceId,
    cost: cheapest.ShippingServiceCost?.Amount
  });

  // Step B: createShipment
  // Amazon SP-API returns: { payload: { Shipment: { Label: {...}, TrackingId: "..." } } }
  const shipmentResponse = await retryWithBackoff(
    () =>
      sp.callAPI({
        operation: 'createShipment',
        endpoint: 'merchantFulfillment',
        body: {
          ShipmentRequestDetails: {
            AmazonOrderId: amazon_order_id,
            ItemList: [
              {
                OrderItemId: amazon_order_id,
                Quantity: quantity || 1
              }
            ],
            ShipFromAddress: SHIP_FROM_ADDRESS,
            PackageDimensions: dimensions,
            Weight: weight,
            ShippingServiceOptions: {
              DeliveryExperience: 'DeliveryConfirmationWithoutSignature',
              CarrierWillPickUp: false,
              LabelFormat: 'ZPL203'
            }
          },
          ShippingServiceId: cheapest.ShippingServiceId
        }
      }),
    { context: `createShipment ${amazon_order_id}` }
  );

  // Extract shipment from payload wrapper (both mock and real API use this structure)
  const shipment = shipmentResponse.payload.Shipment;
  
  if (!shipment) {
    throw new Error('Shipment data missing in createShipment response.');
  }

  const labelDetails = shipment.Label;
  if (!labelDetails || !labelDetails.FileContents) {
    throw new Error('Label data missing in createShipment response.');
  }

  // Amazon returns the label in FileContents.Contents (base64-encoded gzipped ZPL)
  const base64Gzipped = labelDetails.FileContents.Contents;
  
  if (!base64Gzipped) {
    throw new Error('Label file contents missing in createShipment response.');
  }

  const trackingId = shipment.TrackingId || null;

  logger.info('Label purchased successfully', {
    operation: 'buyLabel',
    amazon_order_id,
    trackingId,
    hasLabel: !!base64Gzipped
  });

  return {
    labelGzipped: base64Gzipped,
    sku,
    quantity,
    trackingId
  };
}

export function gunzipBase64Zpl(base64Gzipped) {
  const gzippedBuffer = Buffer.from(base64Gzipped, 'base64');
  const zplBuffer = zlib.gunzipSync(gzippedBuffer);
  return zplBuffer.toString('utf8');
}

