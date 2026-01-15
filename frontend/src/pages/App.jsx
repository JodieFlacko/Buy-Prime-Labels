import React, { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from '../lib/api.js';
import { Modal } from '../components/Modal.jsx';

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function App() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('toShip'); // 'toShip' or 'labelBought'

  const [buyOpen, setBuyOpen] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [weightValue, setWeightValue] = useState('1');
  const [weightUnit, setWeightUnit] = useState('oz');
  const [dimUnit, setDimUnit] = useState('in');
  const [dimL, setDimL] = useState('10');
  const [dimW, setDimW] = useState('6');
  const [dimH, setDimH] = useState('2');
  const [buying, setBuying] = useState(false);
  const [autoFilled, setAutoFilled] = useState(false);

  // Bulk operations state
  const [selectedOrderIds, setSelectedOrderIds] = useState(new Set());
  const [bulkWeightValue, setBulkWeightValue] = useState('10');
  const [bulkWeightUnit, setBulkWeightUnit] = useState('oz');
  const [bulkBuying, setBulkBuying] = useState(false);
  const [batchReportOpen, setBatchReportOpen] = useState(false);
  const [batchReport, setBatchReport] = useState(null);
  
  // Reprint state
  const [reprinting, setReprinting] = useState(false);
  const [bulkReprinting, setBulkReprinting] = useState(false);

  async function loadOrders() {
    setLoading(true);
    setError('');
    try {
      const data = await apiGet('/api/orders');
      setOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function syncOrders() {
    setSyncing(true);
    setError('');
    try {
      await apiPost('/api/sync-orders', {});
      await loadOrders();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    loadOrders();
  }, []);

  const rows = useMemo(() => {
    const filtered = orders.filter((o) => {
      if (activeTab === 'toShip') {
        return o.status === 'Unshipped' || !o.status;
      } else {
        return o.status === 'LabelBought';
      }
    });

    const mapped = filtered.map((o) => {
      const items = Array.isArray(o.items) ? o.items : (o.items?.items || o.items || []);
      return {
        ...o,
        _items: Array.isArray(items) ? items : []
      };
    });

    // Sort label bought orders by most recent first
    if (activeTab === 'labelBought') {
      return mapped.sort((a, b) => {
        const dateA = a.purchase_date ? new Date(a.purchase_date).getTime() : 0;
        const dateB = b.purchase_date ? new Date(b.purchase_date).getTime() : 0;
        return dateB - dateA;
      });
    }

    return mapped;
  }, [orders, activeTab]);

  async function openBuy(orderId) {
    setSelectedOrderId(orderId);
    setAutoFilled(false);
    
    // Reset to default values
    setWeightValue('1');
    setWeightUnit('oz');
    setDimUnit('in');
    setDimL('10');
    setDimW('6');
    setDimH('2');
    
    // Check if order has exactly 1 distinct SKU and fetch shipping defaults
    const order = orders.find((o) => o.amazon_order_id === orderId);
    if (order) {
      const items = Array.isArray(order.items) ? order.items : (order.items?.items || order.items || []);
      const distinctSkus = new Set(items.map(item => item.sku));
      
      if (distinctSkus.size === 1) {
        const sku = Array.from(distinctSkus)[0];
        try {
          const defaults = await apiGet(`/api/shipping-defaults/${sku}`);
          if (defaults) {
            // Auto-fill the form with defaults
            setWeightValue(String(defaults.weight_value || '1'));
            setWeightUnit(defaults.weight_unit || 'oz');
            setDimUnit(defaults.dimension_unit || 'in');
            setDimL(String(defaults.length || '10'));
            setDimW(String(defaults.width || '6'));
            setDimH(String(defaults.height || '2'));
            setAutoFilled(true);
          }
        } catch (e) {
          // If fetch fails, just continue with default values
          console.warn('Failed to fetch shipping defaults:', e);
        }
      }
    }
    
    setBuyOpen(true);
  }

  async function submitBuy() {
    setBuying(true);
    setError('');
    try {
      const payload = {
        amazon_order_id: selectedOrderId,
        weight: { unit: weightUnit, value: Number(weightValue) },
        dimensions: {
          unit: dimUnit,
          length: Number(dimL),
          width: Number(dimW),
          height: Number(dimH)
        }
      };
      const result = await apiPost('/api/buy-label', payload);
      const zpl = result?.zpl || '';
      downloadTextFile(`${selectedOrderId}.zpl`, zpl);
      setBuyOpen(false);
      setAutoFilled(false);
      // Reload orders to reflect the status change
      await loadOrders();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBuying(false);
    }
  }

  // Bulk operations handlers
  function toggleOrderSelection(orderId) {
    const newSelected = new Set(selectedOrderIds);
    if (newSelected.has(orderId)) {
      newSelected.delete(orderId);
    } else {
      newSelected.add(orderId);
    }
    setSelectedOrderIds(newSelected);
  }

  function toggleSelectAll() {
    if (selectedOrderIds.size === rows.length && rows.length > 0) {
      setSelectedOrderIds(new Set());
    } else {
      setSelectedOrderIds(new Set(rows.map((o) => o.amazon_order_id)));
    }
  }

  async function submitBulkBuy() {
    if (selectedOrderIds.size === 0) return;

    setBulkBuying(true);
    setError('');
    try {
      const payload = {
        amazon_order_ids: Array.from(selectedOrderIds),
        weight: { unit: bulkWeightUnit, value: Number(bulkWeightValue) },
        dimensions: {
          unit: dimUnit,
          length: Number(dimL),
          width: Number(dimW),
          height: Number(dimH)
        }
      };
      const result = await apiPost('/api/bulk-buy-labels', payload);
      
      // Download combined ZPL file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      downloadTextFile(`Bulk_Labels_${timestamp}.zpl`, result.zpl || '');

      // Show batch report if there were failures
      if (result.failed && result.failed.length > 0) {
        setBatchReport(result);
        setBatchReportOpen(true);
      }

      // Clear selection
      setSelectedOrderIds(new Set());
      
      // Reload orders to reflect status changes
      await loadOrders();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBulkBuying(false);
    }
  }

  async function handleReprint(orderId) {
    setReprinting(true);
    setError('');
    try {
      const response = await fetch(`/api/reprint/${orderId}`);
      if (!response.ok) {
        let errorMessage = 'Failed to reprint label';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          const text = await response.text();
          errorMessage = text || errorMessage;
        }
        throw new Error(errorMessage);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${orderId}.zpl`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setReprinting(false);
    }
  }

  async function submitBulkReprint() {
    if (selectedOrderIds.size === 0) return;

    setBulkReprinting(true);
    setError('');
    try {
      const payload = {
        amazon_order_ids: Array.from(selectedOrderIds)
      };
      const result = await apiPost('/api/bulk-reprint', payload);
      
      // Download combined ZPL file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      downloadTextFile(`Bulk_Reprint_${timestamp}.zpl`, result.zpl || '');

      // Show batch report if there were failures
      if (result.failed && result.failed.length > 0) {
        setBatchReport(result);
        setBatchReportOpen(true);
      }

      // Clear selection
      setSelectedOrderIds(new Set());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBulkReprinting(false);
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-2xl font-semibold tracking-tight text-gray-900">Prime Label Manager</div>
            <div className="mt-1 text-sm text-gray-500">
              Sync Prime MFN unshipped orders, then buy and download ZPL labels with SKU/QTY injected.
            </div>
          </div>
          <div className="flex gap-3">
            <button
              className="rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
              onClick={loadOrders}
              disabled={loading || syncing}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
              onClick={syncOrders}
              disabled={loading || syncing}
            >
              {syncing ? 'Syncing…' : 'Sync Orders'}
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-6 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <div className="mt-8 overflow-hidden rounded border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 bg-gray-50">
            <div className="flex items-center justify-between px-6 py-4">
              <div className="flex gap-2">
                <button
                  className={`rounded px-4 py-2 text-sm font-medium transition-colors ${
                    activeTab === 'toShip'
                      ? 'bg-gray-900 text-white'
                      : 'bg-transparent text-gray-600 hover:bg-gray-100'
                  }`}
                  onClick={() => {
                    setActiveTab('toShip');
                    setSelectedOrderIds(new Set());
                  }}
                >
                  To Buy
                </button>
                <button
                  className={`rounded px-4 py-2 text-sm font-medium transition-colors ${
                    activeTab === 'labelBought'
                      ? 'bg-gray-900 text-white'
                      : 'bg-transparent text-gray-600 hover:bg-gray-100'
                  }`}
                  onClick={() => {
                    setActiveTab('labelBought');
                    setSelectedOrderIds(new Set());
                  }}
                >
                  Label Bought
                </button>
              </div>
              <div className="text-xs font-medium text-gray-500">
                {rows.length} {rows.length === 1 ? 'order' : 'orders'}
              </div>
            </div>
          </div>

          {/* Bulk Action Bar */}
          {selectedOrderIds.size > 0 && (
            <div className="border-b border-gray-200 bg-gray-50 px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-gray-700">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-900 text-xs font-medium text-white">
                    {selectedOrderIds.size}
                  </span>
                  <span className="font-medium">order{selectedOrderIds.size !== 1 ? 's' : ''} selected</span>
                </div>
                <div className="flex items-center gap-3">
                  {activeTab === 'toShip' ? (
                    <>
                      <div className="flex items-center gap-2 rounded border border-gray-300 bg-white px-3 py-1.5">
                        <span className="text-xs text-gray-600">Global Weight:</span>
                        <input
                          className="w-20 rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                          value={bulkWeightValue}
                          onChange={(e) => setBulkWeightValue(e.target.value)}
                          inputMode="decimal"
                        />
                        <select
                          className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                          value={bulkWeightUnit}
                          onChange={(e) => setBulkWeightUnit(e.target.value)}
                        >
                          <option value="oz">oz</option>
                          <option value="lb">lb</option>
                          <option value="g">g</option>
                          <option value="kg">kg</option>
                        </select>
                      </div>
                      <button
                        className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
                        onClick={submitBulkBuy}
                        disabled={bulkBuying}
                      >
                        {bulkBuying ? 'Processing…' : `Buy Shipping for ${selectedOrderIds.size} Order${selectedOrderIds.size !== 1 ? 's' : ''}`}
                      </button>
                    </>
                  ) : (
                    <button
                      className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
                      onClick={submitBulkReprint}
                      disabled={bulkReprinting}
                    >
                      {bulkReprinting ? 'Reprinting…' : `Reprint ${selectedOrderIds.size} Label${selectedOrderIds.size !== 1 ? 's' : ''}`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-gray-50">
                <tr className="text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-6 py-3">
                    {activeTab === 'toShip' || activeTab === 'labelBought' ? (
                      <input
                        type="checkbox"
                        checked={rows.length > 0 && selectedOrderIds.size === rows.length}
                        onChange={toggleSelectAll}
                        className="h-4 w-4 cursor-pointer rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                      />
                    ) : null}
                  </th>
                  <th className="px-6 py-3">Date</th>
                  <th className="px-6 py-3">Order ID</th>
                  <th className="px-6 py-3">Customer</th>
                  <th className="px-6 py-3">Items (SKU / Qty)</th>
                  {activeTab === 'labelBought' ? (
                    <th className="px-6 py-3">Tracking</th>
                  ) : null}
                  <th className="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {rows.map((o) => (
                  <tr key={o.amazon_order_id} className="transition-colors hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <input
                        type="checkbox"
                        checked={selectedOrderIds.has(o.amazon_order_id)}
                        onChange={() => toggleOrderSelection(o.amazon_order_id)}
                        className="h-4 w-4 cursor-pointer rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                      />
                    </td>
                    <td className="px-6 py-4 text-gray-900">{formatDate(o.purchase_date)}</td>
                    <td className="px-6 py-4 font-mono text-xs text-gray-900">{o.amazon_order_id}</td>
                    <td className="px-6 py-4 text-gray-900">{o.customer_name || '-'}</td>
                    <td className="px-6 py-4 text-gray-900">
                      <div className="flex flex-wrap gap-2">
                        {o._items.length ? (
                          o._items.map((it, idx) => (
                            <span
                              key={`${it.sku}-${idx}`}
                              className="inline-flex items-center rounded border border-gray-300 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-700"
                            >
                              <span className="font-mono">{it.sku}</span>
                              <span className="mx-1.5 text-gray-400">·</span>
                              <span className="font-medium">x{it.quantity}</span>
                            </span>
                          ))
                        ) : (
                          <span className="text-gray-400">No items</span>
                        )}
                      </div>
                    </td>
                    {activeTab === 'labelBought' ? (
                      <td className="px-6 py-4 text-gray-900">
                        {o.tracking_id ? (
                          <span className="font-mono text-xs">{o.tracking_id}</span>
                        ) : (
                          <span className="text-gray-400 text-xs">-</span>
                        )}
                      </td>
                    ) : null}
                    <td className="px-6 py-4 text-right">
                      {activeTab === 'toShip' ? (
                        <button
                          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                          onClick={() => openBuy(o.amazon_order_id)}
                        >
                          Buy Label
                        </button>
                      ) : (
                        <button
                          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                          onClick={() => handleReprint(o.amazon_order_id)}
                          disabled={reprinting}
                        >
                          {reprinting ? 'Reprinting…' : 'Reprint Label'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td className="px-6 py-12 text-center" colSpan={activeTab === 'labelBought' ? 7 : activeTab === 'toShip' ? 6 : 5}>
                      <div className="flex flex-col items-center gap-2">
                        <div className="text-sm text-gray-400">
                          {activeTab === 'toShip' 
                            ? 'No orders to ship. Click "Sync Orders" to get started.'
                            : 'No labels bought yet.'}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Modal
        open={buyOpen}
        title={`Buy Label — ${selectedOrderId}`}
        onClose={() => (buying ? null : setBuyOpen(false))}
      >
        <div className="grid grid-cols-1 gap-5">
          {autoFilled && (
            <div className="rounded border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-700">
              <span className="font-medium">Auto-filled from history</span>
            </div>
          )}
          <div className="rounded border border-gray-200 bg-white p-4">
            <div className="mb-3 text-sm font-medium text-gray-700">
              Weight
            </div>
            <div className="flex gap-2">
              <input
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                value={weightValue}
                onChange={(e) => setWeightValue(e.target.value)}
                inputMode="decimal"
              />
              <select
                className="rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                value={weightUnit}
                onChange={(e) => setWeightUnit(e.target.value)}
              >
                <option value="oz">oz</option>
                <option value="lb">lb</option>
                <option value="g">g</option>
                <option value="kg">kg</option>
              </select>
            </div>
          </div>

          <div className="rounded border border-gray-200 bg-white p-4">
            <div className="mb-3 text-sm font-medium text-gray-700">
              Dimensions
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input
                className="rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                value={dimL}
                onChange={(e) => setDimL(e.target.value)}
                placeholder="Length"
                inputMode="decimal"
              />
              <input
                className="rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                value={dimW}
                onChange={(e) => setDimW(e.target.value)}
                placeholder="Width"
                inputMode="decimal"
              />
              <input
                className="rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                value={dimH}
                onChange={(e) => setDimH(e.target.value)}
                placeholder="Height"
                inputMode="decimal"
              />
            </div>
            <div className="mt-3 flex justify-end">
              <select
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 outline-none transition-colors focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                value={dimUnit}
                onChange={(e) => setDimUnit(e.target.value)}
              >
                <option value="in">in</option>
                <option value="cm">cm</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              className="rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
              onClick={() => {
                setBuyOpen(false);
                setAutoFilled(false);
              }}
              disabled={buying}
            >
              Cancel
            </button>
            <button
              className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
              onClick={submitBuy}
              disabled={buying}
            >
              {buying ? 'Buying…' : 'Buy & Download .zpl'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Batch Report Modal */}
      <Modal
        open={batchReportOpen}
        title="Batch Report"
        onClose={() => setBatchReportOpen(false)}
      >
        {batchReport && (
          <div className="space-y-5">
            <div className="rounded border border-gray-200 bg-white p-5">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="rounded border border-gray-200 bg-gray-50 p-4">
                  <div className="text-2xl font-semibold text-gray-900">{batchReport.summary?.total || 0}</div>
                  <div className="mt-1 text-xs font-medium text-gray-500">Total</div>
                </div>
                <div className="rounded border border-green-200 bg-green-50 p-4">
                  <div className="text-2xl font-semibold text-green-700">{batchReport.summary?.succeeded || 0}</div>
                  <div className="mt-1 text-xs font-medium text-green-600">Succeeded</div>
                </div>
                <div className="rounded border border-red-200 bg-red-50 p-4">
                  <div className="text-2xl font-semibold text-red-700">{batchReport.summary?.failed || 0}</div>
                  <div className="mt-1 text-xs font-medium text-red-600">Failed</div>
                </div>
              </div>
            </div>

            {batchReport.failed && batchReport.failed.length > 0 && (
              <div className="rounded border border-red-200 bg-red-50 p-4">
                <div className="mb-3 text-sm font-medium text-red-800">
                  Failed Orders:
                </div>
                <div className="max-h-60 space-y-2 overflow-y-auto">
                  {batchReport.failed.map((failure, idx) => (
                    <div key={idx} className="rounded border border-red-200 bg-white p-3 text-xs">
                      <div className="font-mono font-medium text-red-900">{failure.amazon_order_id}</div>
                      <div className="mt-1.5 text-red-700">{failure.error}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
                onClick={() => setBatchReportOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

