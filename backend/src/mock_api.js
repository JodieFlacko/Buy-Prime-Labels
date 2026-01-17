import zlib from 'zlib';

// Simple in-memory mock store so results are stable while the process is running.
// Mock data configured for Italy (Italian addresses, postal codes, etc.)
// Structure matches Amazon SP-API Orders API v0 response format with PascalCase

// IMPORTANT: This mock simulates the REAL Amazon SP-API structure:
// 1. Orders come from GET /orders/v0/orders (returns payload.Orders array)
// 2. Order items come from GET /orders/v0/orders/{orderId}/orderItems (returns payload.OrderItems array)
// 3. All field names use PascalCase (AmazonOrderId, not amazon_order_id)

const mockOrdersData = [
  {
    AmazonOrderId: 'MOCK-ORDER-3',
    PurchaseDate: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
    OrderStatus: 'Unshipped',
    IsPrime: false, // Useful for testing filtering logic (Non-Prime)
    ShippingAddress: {
      Name: 'Alessandro Verdi',
      AddressLine1: 'Piazza del Plebiscito 1',
      City: 'Napoli',
      StateOrRegion: 'NA',
      PostalCode: '80132',
      CountryCode: 'IT',
      Phone: '+390812345678'
    }
  },
  {
    AmazonOrderId: 'MOCK-ORDER-4',
    PurchaseDate: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    OrderStatus: 'Unshipped',
    IsPrime: true,
    ShippingAddress: {
      Name: 'Francesca Neri',
      AddressLine1: 'Via Indipendenza 8',
      City: 'Bologna',
      StateOrRegion: 'BO',
      PostalCode: '40121',
      CountryCode: 'IT',
      Phone: '+390512345678'
    }
  },
  {
    AmazonOrderId: 'MOCK-ORDER-5',
    PurchaseDate: new Date(Date.now() - 432000000).toISOString(), // 5 days ago
    OrderStatus: 'Unshipped',
    IsPrime: true,
    ShippingAddress: {
      Name: 'Lorenzo Esposito',
      AddressLine1: 'Calle Larga XXII Marzo 2099',
      City: 'Venezia',
      StateOrRegion: 'VE',
      PostalCode: '30124',
      CountryCode: 'IT',
      Phone: '+390412345678'
    }
  },
  {
    AmazonOrderId: 'MOCK-ORDER-6',
    PurchaseDate: new Date().toISOString(), // Just now
    OrderStatus: 'Unshipped',
    IsPrime: true,
    ShippingAddress: {
      Name: 'Sofia Ricci',
      AddressLine1: 'Via Etnea 200',
      City: 'Catania',
      StateOrRegion: 'CT',
      PostalCode: '95124',
      CountryCode: 'IT',
      Phone: '+390952345678'
    }
  },
  {
    AmazonOrderId: 'MOCK-ORDER-7',
    PurchaseDate: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
    OrderStatus: 'Unshipped',
    IsPrime: true,
    ShippingAddress: {
      Name: 'Matteo Romano',
      AddressLine1: 'Corso Porta Nuova 55',
      City: 'Verona',
      StateOrRegion: 'VR',
      PostalCode: '37122',
      CountryCode: 'IT',
      Phone: '+390452345678'
    }
  }
];

// Separate mock data for order items (simulates GET /orders/v0/orders/{orderId}/orderItems)
const mockOrderItemsData = {
  'MOCK-ORDER-3': [
    { SellerSKU: 'SKU-GHI', QuantityOrdered: 1, OrderItemId: '12345678901234' },
    { SellerSKU: 'SKU-JKL', QuantityOrdered: 1, OrderItemId: '12345678901235' },
    { SellerSKU: 'SKU-MNO', QuantityOrdered: 1, OrderItemId: '12345678901236' }
  ],
  'MOCK-ORDER-4': [
    { SellerSKU: 'SKU-PQR', QuantityOrdered: 5, OrderItemId: '12345678901237' } // High quantity test
  ],
  'MOCK-ORDER-5': [
    { SellerSKU: 'SKU-STU', QuantityOrdered: 1, OrderItemId: '12345678901238' }
  ],
  'MOCK-ORDER-6': [
    { SellerSKU: 'SKU-VWX', QuantityOrdered: 2, OrderItemId: '12345678901239' },
    { SellerSKU: 'SKU-YZA', QuantityOrdered: 2, OrderItemId: '12345678901240' }
  ],
  'MOCK-ORDER-7': [
    { SellerSKU: 'SKU-BCD', QuantityOrdered: 1, OrderItemId: '12345678901241' }
  ]
};

/**
 * Simulates the real Amazon SP-API flow:
 * 1. Calls GET /orders/v0/orders to get orders (returns { payload: { Orders: [...] } })
 * 2. For each order, calls GET /orders/v0/orders/{orderId}/orderItems (returns { payload: { OrderItems: [...] } })
 * 3. Hydrates the orders with their items and returns the combined structure
 * 
 * This ensures the mock behaves EXACTLY like the real API would.
 */
export async function mockFetchUnshippedPrimeOrdersWithItems() {
  // Simulate network latency for fetching orders
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Step 1: Simulate GET /orders/v0/orders
  const ordersResponse = {
    payload: {
      Orders: mockOrdersData
    }
  };

  // Return the response in Amazon's exact format (with payload wrapper)
  // The transformation to snake_case should happen in amazonClient.js
  return ordersResponse;
}

/**
 * Simulates GET /orders/v0/orders/{orderId}/orderItems
 * Returns order items for a specific order in Amazon's format
 */
export async function mockGetOrderItems(orderId) {
  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    payload: {
      OrderItems: mockOrderItemsData[orderId] || []
    }
  };
}

/**
 * Simulates Amazon Merchant Fulfillment API (MFN) label purchase flow.
 * Real flow:
 * 1. getEligibleShipmentServices - returns { ShippingServiceList: [...] }
 * 2. createShipment - returns { Shipment: { Label: { FileContents: { Data: "..." } }, TrackingId: "..." } }
 * 
 * This mock combines both steps and returns the label data in Amazon's structure.
 */
export async function mockBuyLabel({ amazon_order_id, weight, dimensions }) {
  // Find the order (using the parameter name for backwards compatibility)
  const order = mockOrdersData.find((o) => o.AmazonOrderId === amazon_order_id) || mockOrdersData[0];
  const orderItems = mockOrderItemsData[order.AmazonOrderId] || [];
  const firstItem = orderItems[0] || { SellerSKU: 'UNKNOWN', QuantityOrdered: 1 };

  // Generate mock ZPL label
  const baseZpl = `
^XA
^CF0,30
^FO50,50^FD Amazon Prime Label (MOCK)^FS
^FO50,100^FD Order: ${order.AmazonOrderId}^FS
^FO50,150^FD Ship To: ${order.ShippingAddress.Name}^FS
^FO50,200^FD Address: ${order.ShippingAddress.AddressLine1}^FS
^FO50,250^FD City: ${order.ShippingAddress.City}^FS
^FO50,300^FD Country: ${order.ShippingAddress.CountryCode}^FS
^XZ
`.trim();

  const gzipped = zlib.gzipSync(Buffer.from(baseZpl, 'utf8'));

  // Return structure matching Amazon MFN API createShipment response
  return {
    Shipment: {
      ShipmentId: `MOCK-SHIPMENT-${amazon_order_id}`,
      TrackingId: `MOCK-TRACKING-${amazon_order_id}`,
      Label: {
        Dimensions: {
          Length: 4,
          Width: 6,
          Unit: 'inches'
        },
        FileContents: {
          Contents: gzipped.toString('base64'),
          FileType: 'application/zpl',
          Checksum: 'mock-checksum'
        },
        LabelFormat: 'ZPL203'
      }
    },
    // Add these fields for backwards compatibility with existing code
    labelGzipped: gzipped.toString('base64'),
    sku: firstItem.SellerSKU,
    quantity: firstItem.QuantityOrdered,
    trackingId: `MOCK-TRACKING-${amazon_order_id}`
  };
}