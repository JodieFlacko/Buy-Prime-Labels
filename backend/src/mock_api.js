import zlib from 'zlib';

// Simple in-memory mock store so results are stable while the process is running.
// Mock data configured for Italy (Italian addresses, postal codes, etc.)
const mockOrders = [
  // --- New Orders Added Below ---
  {
    amazon_order_id: 'MOCK-ORDER-3',
    purchase_date: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
    customer_name: 'Alessandro Verdi',
    shipping_address: {
      name: 'Alessandro Verdi',
      addressLine1: 'Piazza del Plebiscito 1',
      city: 'Napoli',
      stateOrRegion: 'NA',
      postalCode: '80132',
      countryCode: 'IT',
      phone: '+390812345678'
    },
    items: [
      { sku: 'SKU-GHI', quantity: 1 },
      { sku: 'SKU-JKL', quantity: 1 },
      { sku: 'SKU-MNO', quantity: 1 }
    ],
    is_prime: false, // Useful for testing filtering logic (Non-Prime)
    status: 'Unshipped'
  },
  {
    amazon_order_id: 'MOCK-ORDER-4',
    purchase_date: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    customer_name: 'Francesca Neri',
    shipping_address: {
      name: 'Francesca Neri',
      addressLine1: 'Via Indipendenza 8',
      city: 'Bologna',
      stateOrRegion: 'BO',
      postalCode: '40121',
      countryCode: 'IT',
      phone: '+390512345678'
    },
    items: [
      { sku: 'SKU-PQR', quantity: 5 } // High quantity test
    ],
    is_prime: true,
    status: 'Unshipped'
  },
  {
    amazon_order_id: 'MOCK-ORDER-5',
    purchase_date: new Date(Date.now() - 432000000).toISOString(), // 5 days ago
    customer_name: 'Lorenzo Esposito',
    shipping_address: {
      name: 'Lorenzo Esposito',
      addressLine1: 'Calle Larga XXII Marzo 2099',
      city: 'Venezia',
      stateOrRegion: 'VE',
      postalCode: '30124',
      countryCode: 'IT',
      phone: '+390412345678'
    },
    items: [
      { sku: 'SKU-STU', quantity: 1 }
    ],
    is_prime: true,
    status: 'Unshipped'
  },
  {
    amazon_order_id: 'MOCK-ORDER-6',
    purchase_date: new Date().toISOString(), // Just now
    customer_name: 'Sofia Ricci',
    shipping_address: {
      name: 'Sofia Ricci',
      addressLine1: 'Via Etnea 200',
      city: 'Catania',
      stateOrRegion: 'CT',
      postalCode: '95124',
      countryCode: 'IT',
      phone: '+390952345678'
    },
    items: [
      { sku: 'SKU-VWX', quantity: 2 },
      { sku: 'SKU-YZA', quantity: 2 }
    ],
    is_prime: true,
    status: 'Unshipped'
  },
  {
    amazon_order_id: 'MOCK-ORDER-7',
    purchase_date: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
    customer_name: 'Matteo Romano',
    shipping_address: {
      name: 'Matteo Romano',
      addressLine1: 'Corso Porta Nuova 55',
      city: 'Verona',
      stateOrRegion: 'VR',
      postalCode: '37122',
      countryCode: 'IT',
      phone: '+390452345678'
    },
    items: [
      { sku: 'SKU-BCD', quantity: 1 }
    ],
    is_prime: true,
    status: 'Unshipped'
  }
];

export async function mockFetchUnshippedPrimeOrdersWithItems() {
  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 200));
  return mockOrders;
}

export async function mockBuyLabel({ amazon_order_id, weight, dimensions }) {
  const order = mockOrders.find((o) => o.amazon_order_id === amazon_order_id) || mockOrders[0];
  const firstItem = order.items[0] || { sku: 'UNKNOWN', quantity: 1 };

  const baseZpl = `
^XA
^CF0,30
^FO50,50^FD Amazon Prime Label (MOCK)^FS
^FO50,100^FD Order: ${order.amazon_order_id}^FS
^FO50,150^FD Ship To: ${order.customer_name}^FS
^FO50,200^FD Address: ${order.shipping_address.addressLine1}^FS
^FO50,250^FD City: ${order.shipping_address.city}^FS
^FO50,300^FD Country: ${order.shipping_address.countryCode}^FS
^XZ
`.trim();

  const gzipped = zlib.gzipSync(Buffer.from(baseZpl, 'utf8'));

  return {
    // In real SP-API this is typically a base64-encoded, gzipped ZPL.
    labelGzipped: gzipped.toString('base64'),
    sku: firstItem.sku,
    quantity: firstItem.quantity,
    trackingId: `MOCK-TRACKING-${amazon_order_id}`
  };
}