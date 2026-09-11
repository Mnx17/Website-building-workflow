import { z } from 'zod';
import { getSql } from '@/lib/db';
import { AuthError, requireRole } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { errorResponse } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  status: z
    .enum(['paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'])
    .optional(),
  clear_review: z.boolean().optional(),
  review_note: z.string().trim().max(500).optional(),
});

/**
 * Order transitions and review handling.
 *
 * The legality of a transition is NOT checked here — `assert_order_transition`
 * enforces it in the database, so a bug in this handler (or any future admin
 * client) cannot corrupt order state. This route's job is authorisation and
 * turning the trigger's error into a 409.
 *
 * Refunds also restock, in the same request: a refunded order that silently
 * keeps its stock decremented makes the ledger lie.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const sql = getSql();
    const session = await requireRole(sql, request, ['admin', 'fulfillment']);

    const parsed = patchSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return jsonResponse({ error: 'VALIDATION', issues: parsed.error.issues }, { status: 400 });
    }

    const { status, clear_review, review_note } = parsed.data;

    const row = await sql.begin(async (tx) => {
      if (status) {
        await tx`update orders set status = ${status}::order_status where id = ${id}`;

        if (status === 'refunded' || status === 'cancelled') {
          // No-op for an order whose stock was never committed.
          await tx`select restock_order(${id})`;
        }
      }

      if (clear_review) {
        await tx`
          update orders
             set needs_review = false,
                 review_reason = ${review_note ?? null}
           where id = ${id}
        `;
        await tx`
          insert into admin_audit_log (actor_user_id, action, entity, entity_id, after)
          values (${session.userId}, 'update', 'orders', ${id},
                  ${tx.json({ cleared_review: true, note: review_note ?? null })})
        `;
      }

      const [updated] = await tx`
        select id, order_number, status, needs_review, review_reason
          from orders where id = ${id}
      `;
      return updated;
    });

    if (!row) return jsonResponse({ error: 'NOT_FOUND' }, { status: 404 });
    return jsonResponse({ row });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : '';
    if (message.includes('ILLEGAL_TRANSITION')) {
      return jsonResponse(
        { error: 'ILLEGAL_TRANSITION', detail: message.split('ILLEGAL_TRANSITION:')[1] },
        { status: 409 },
      );
    }
    return errorResponse(error);
  }
}
