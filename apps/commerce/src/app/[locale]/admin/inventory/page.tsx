import { getSql } from '@/lib/db';
import { ledger, lowStock } from '@/lib/repositories/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Inventory view: current position plus the movements that produced it.
 *
 * Adjustments are made through POST /api/admin/inventory, which calls
 * adjust_stock() so the ledger and raw_materials cannot drift. There is
 * deliberately no direct stock field to edit on this page.
 */
export default async function AdminInventory() {
  const sql = getSql();
  const [low, entries] = await Promise.all([lowStock(sql), ledger(sql, { limit: 100 })]);

  return (
    <>
      <h1>Inventory</h1>

      <section className="card">
        <h2>Below threshold ({low.length})</h2>
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th><th>Item</th>
              <th className="num">Stock</th><th className="num">On hold</th>
              <th className="num">Available</th>
            </tr>
          </thead>
          <tbody>
            {low.map((row) => (
              <tr key={row.id}>
                <td>{row.sku}</td>
                <td>{row.name_en}</td>
                <td className="num">{row.stock_qty}</td>
                <td className="num">{row.reserved_qty}</td>
                <td className="num">{row.available}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Ledger</h2>
        <p className="card__hint">
          Append-only. Every movement is here, including reservations that were
          never paid for.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>When</th><th>SKU</th><th>Reason</th>
              <th className="num">Stock Δ</th><th className="num">Hold Δ</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td>{row.sku}</td>
                <td>{row.reason}</td>
                <td className="num">{row.delta_stock_qty || ''}</td>
                <td className="num">{row.delta_reserved_qty || ''}</td>
                <td>{row.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
