import { getSql } from '@/lib/db';
import { lowStock, ordersNeedingReview } from '@/lib/repositories/admin';
import { formatOmr } from '@/lib/money';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dashboard: the two things that need a human today.
 *
 * Orders needing review come first. A `reservation_lost` order means a
 * customer has been charged for stock that may not exist — that outranks a
 * low-stock warning every time.
 */
export default async function AdminDashboard() {
  const sql = getSql();
  const [low, review, counts] = await Promise.all([
    lowStock(sql),
    ordersNeedingReview(sql),
    sql<{ status: string; count: string; value: string }[]>`
      select status, count(*) as count, coalesce(sum(total_baisa), 0) as value
        from orders group by status order by status
    `,
  ]);

  return (
    <>
      <h1>Dashboard</h1>

      <section className="card card--alert" hidden={review.length === 0}>
        <h2>Needs review ({review.length})</h2>
        <p className="card__hint">
          Payment succeeded but the stock hold had already expired. Verify
          availability before fulfilling.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Status</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {review.map((order) => (
              <tr key={order.id}>
                <td>{order.order_number}</td>
                <td>{order.status}</td>
                <td>{order.review_reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Low stock ({low.length})</h2>
        {low.length === 0 ? (
          <p className="card__hint">Nothing below its threshold.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Item</th>
                <th className="num">Available</th>
                <th className="num">On hold</th>
                <th className="num">Threshold</th>
              </tr>
            </thead>
            <tbody>
              {low.map((row) => (
                <tr key={row.id}>
                  <td>{row.sku}</td>
                  <td>{row.name_en}</td>
                  <td className="num">{row.available}</td>
                  <td className="num">{row.reserved_qty}</td>
                  <td className="num">{row.low_stock_threshold}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Orders</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Status</th>
              <th className="num">Count</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {counts.map((row) => (
              <tr key={row.status}>
                <td>{row.status}</td>
                <td className="num">{row.count}</td>
                <td className="num">{formatOmr(BigInt(row.value))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
