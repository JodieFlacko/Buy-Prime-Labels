import zlib from 'zlib';
import SellingPartnerAPI from 'amazon-sp-api';
import { AMAZON_CONFIG, SHIP_FROM_ADDRESS, USE_MOCK } from './config.js';
import { mockFetchUnshippedPrimeOrdersWithItems, mockBuyLabel } from './mock_api.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (USE_MOCK) {
    return mockFetchUnshippedPrimeOrdersWithItems();
  }

  const sp = await createSpClient();

  // Step A: GET /orders/v0/orders
  const ordersResponse = await sp.callAPI({
    operation: 'getOrders',
    endpoint: 'orders',
    query: {
      MarketplaceIds: [AMAZON_CONFIG.marketplaceId].filter(Boolean),
      OrderStatuses: ['Unshipped'],
      FulfillmentChannels: ['MFN']
    }
  });

  const orders = ordersResponse.Orders || [];

  const primeOrders = orders.filter((o) => o.IsPrime);

  const hydrated = [];

  for (const order of primeOrders) {
    // Step C: Hydrate with items (throttle 500ms)
    await sleep(500);

    const itemsResponse = await sp.callAPI({
      operation: 'getOrderItems',
      endpoint: 'orders',
      path: {
        orderId: order.AmazonOrderId
      }
    });

    const items = (itemsResponse.OrderItems || []).map((item) => ({
      sku: item.SellerSKU,
      quantity: item.QuantityOrdered
    }));

    hydrated.push({
      amazon_order_id: order.AmazonOrderId,
      purchase_date: order.PurchaseDate,
      customer_name: (order.ShippingAddress && order.ShippingAddress.Name) || 'Unknown',
      shipping_address: order.ShippingAddress || {},
      items,
      is_prime: !!order.IsPrime,
      status: order.OrderStatus || 'Unshipped'
    });
  }

  return hydrated;
}

export async function buyLabel({ amazon_order_id, weight, dimensions, sku, quantity }) {
  if (USE_MOCK) {
    return mockBuyLabel({ amazon_order_id, weight, dimensions });
  }

  const sp = await createSpClient();

  // Step A: getEligibleShipmentServices
  const eligibleResponse = await sp.callAPI({
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
  });

  const services = eligibleResponse.ShippingServiceList || [];
  if (!services.length) {
    throw new Error('No eligible shipping services returned from Amazon.');
  }

  const cheapest = services.reduce((min, s) => {
    const cost = Number(s.ShippingServiceCost && s.ShippingServiceCost.Amount) || Infinity;
    return cost < min.cost ? { service: s, cost } : min;
  }, { service: services[0], cost: Number(services[0].ShippingServiceCost.Amount) || Infinity }).service;

  // Step B: createShipment
  const shipmentResponse = await sp.callAPI({
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
  });

  const shipment = shipmentResponse.Shipment;
  if (!shipment) {
    throw new Error('Shipment data missing in createShipment response.');
  }

  const labelDetails = shipment.Label;
  if (!labelDetails || !labelDetails.FileContents || !labelDetails.FileContents.Data) {
    throw new Error('Label data missing in createShipment response.');
  }

  const base64Gzipped = labelDetails.FileContents.Data;
  const trackingId = shipment.TrackingId || null;

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

