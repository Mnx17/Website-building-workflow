import { z } from 'zod';
import { getSql } from '@/lib/db';
import { AuthError, requireRole } from '@/lib/auth';
import { adjustStock, ledger, lowStock } from '@/lib/repositories/admin';
import { jsonResponse, readJson } from '@/lib/http';
import { errorResponse } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — low-stock alerts and the ledger view behind them. */
export async function GET(request: Request): Promise<Response> {
  try {
    const sql = getSql();
    await requireRole(sql, request, ['admin', 'editor', 'fulfillment']);

    const url = new URL(request.url);
    const rawMaterialId = url.searchParams.get('raw_material_id') ?? undefined;

    const [low, entries] = await Promise.all([
      lowStock(sql),
      ledger(sql, { rawMaterialId, limit: Number(url.searchParams.get('limit') ?? 100) }),
    ]);

    return jsonResponse({ low_stock: low, ledger: entries });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    return errorResponse(error);
  }
}

const adjustSchema = z.object({
  raw_material_id: z.string().uuid(),
  delta: z.number().int().refine((value) => value !== 0, 'Delta must be non-zero'),
  reason: z.enum(['restock', 'manual_adjust', 'spoilage']),
  /**
   * Required, not optional. An unexplained stock correction is exactly the
   * thing the audit trail exists to prevent.
   */
  note: z.string().trim().min(3).max(500),
});

/** POST — manual stock movement, always through the ledger-writing RPC. */
export async function POST(request: Request): Promise<Response> {
  try {
    const sql = getSql();
    const session = await requireRole(sql, request, ['admin', 'editor']);

    const parsed = adjustSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return jsonResponse({ error: 'VALIDATION', issues: parsed.error.issues }, { status: 400 });
    }

    await adjustStock(sql, {
      rawMaterialId: parsed.data.raw_material_id,
      delta: parsed.data.delta,
      reason: parsed.data.reason,
      note: parsed.data.note,
      actorUserId: session.userId,
    });

    const [material] = await sql<{ stock_qty: number; reserved_qty: number }[]>`
      select stock_qty, reserved_qty from raw_materials where id = ${parsed.data.raw_material_id}
    `;

    return jsonResponse({ ok: true, material });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    return errorResponse(error);
  }
}
