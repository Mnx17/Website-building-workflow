import { getSql } from '@/lib/db';
import { AuthError, requireRole } from '@/lib/auth';
import { auditTrail } from '@/lib/repositories/admin';
import { jsonResponse } from '@/lib/http';
import { errorResponse } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin-only: the audit trail names who changed what, so editors cannot read it. */
export async function GET(request: Request): Promise<Response> {
  try {
    const sql = getSql();
    await requireRole(sql, request, ['admin']);

    const url = new URL(request.url);
    const rows = await auditTrail(sql, {
      entity: url.searchParams.get('entity') ?? undefined,
      entityId: url.searchParams.get('entity_id') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
    });

    return jsonResponse({ rows });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, { status: error.status });
    }
    return errorResponse(error);
  }
}
