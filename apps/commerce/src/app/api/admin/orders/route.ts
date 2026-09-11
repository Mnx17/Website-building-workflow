import { getSql } from '@/lib/db';
import { AuthError, requireRole } from '@/lib/auth';
import { ordersNeedingReview } from '@/lib/repositories/admin';
import { jsonResponse } from '@/lib/http';
import { errorResponse } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const sql = getSql();
    await requireRole(sql, request, ['admin', 'editor', 'fulfillment']);

    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);

    const rows = await sql`
      select o.id, o.order_number, o.status, o.total_baisa, o.total_weight_grams,
             o.placed_at, o.paid_at, o.needs_review, o.review_reason,
             (g.order_id is not null) as is_gift
        from orders o
        left join gift_orders g on g.order_id = o.id
       where ${status ? sql`o.status = ${status}::order_status` : sql`true`}
       order by o.placed_at desc
       limit ${limit}
    `;

    return jsonResponse({ rows, needs_review: await ordersNeedingReview(sql) });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    return errorResponse(error);
  }
}
