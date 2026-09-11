import { getSql } from '../db';
import { AuthError, requireRole, type StaffRole } from '../auth';
import {
  createEntity,
  deactivateEntity,
  updateEntity,
  type AuditableEntity,
} from '../repositories/admin';
import { jsonResponse, readJson } from '../http';
import { errorResponse } from '../errors';

/**
 * Builds the admin CRUD handlers for one entity.
 *
 * Written once rather than copied per entity so the role check, the audit
 * trail and the error mapping cannot drift apart between routes — the usual
 * way an admin panel ends up with one endpoint that forgot to check a role.
 */

export type EntityRouteConfig = {
  entity: AuditableEntity;
  /** Who may read. */
  read: readonly StaffRole[];
  /** Who may write. Usually narrower than read. */
  write: readonly StaffRole[];
  /** Extra SQL fragment name for ordering; defaults to created_at where present. */
  orderBy?: string;
};

function handleError(error: unknown): Response {
  if (error instanceof AuthError) {
    return jsonResponse({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : '';

  if (message.startsWith('NOT_FOUND')) {
    return jsonResponse({ error: 'NOT_FOUND' }, { status: 404 });
  }
  if (message === 'NO_WRITABLE_FIELDS') {
    return jsonResponse({ error: 'NO_WRITABLE_FIELDS' }, { status: 422 });
  }
  if (message === 'STOCK_NOT_DIRECTLY_WRITABLE') {
    return jsonResponse(
      {
        error: 'STOCK_NOT_DIRECTLY_WRITABLE',
        message: 'Adjust stock through the inventory endpoint so the ledger stays accurate.',
      },
      { status: 422 },
    );
  }
  // Unique violations (duplicate slug/sku) are user errors, not faults.
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (code === '23505') {
      return jsonResponse({ error: 'DUPLICATE' }, { status: 409 });
    }
    if (code === '23514' || code === '22023') {
      return jsonResponse({ error: 'CONSTRAINT_VIOLATION', detail: message }, { status: 422 });
    }
  }
  return errorResponse(error);
}

export function collectionHandlers(config: EntityRouteConfig) {
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const sql = getSql();
        await requireRole(sql, request, config.read);

        const rows = await sql`
          select * from ${sql(config.entity)}
           order by ${sql(config.orderBy ?? 'created_at')} desc
           limit 500
        `;
        return jsonResponse({ rows });
      } catch (error) {
        return handleError(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        const sql = getSql();
        const session = await requireRole(sql, request, config.write);

        const body = await readJson(request);
        if (typeof body !== 'object' || body === null) {
          return jsonResponse({ error: 'INVALID_BODY' }, { status: 400 });
        }

        const row = await createEntity(
          sql,
          config.entity,
          body as Record<string, unknown>,
          session.userId,
        );
        return jsonResponse({ row }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },
  };
}

export function itemHandlers(config: EntityRouteConfig) {
  type Context = { params: Promise<{ id: string }> };

  return {
    async PATCH(request: Request, context: Context): Promise<Response> {
      try {
        const { id } = await context.params;
        const sql = getSql();
        const session = await requireRole(sql, request, config.write);

        const body = await readJson(request);
        if (typeof body !== 'object' || body === null) {
          return jsonResponse({ error: 'INVALID_BODY' }, { status: 400 });
        }

        const row = await updateEntity(
          sql,
          config.entity,
          id,
          body as Record<string, unknown>,
          session.userId,
        );
        return jsonResponse({ row });
      } catch (error) {
        return handleError(error);
      }
    },

    /**
     * Deactivates rather than deletes. A product referenced by a historical
     * order must not disappear from under it.
     */
    async DELETE(request: Request, context: Context): Promise<Response> {
      try {
        const { id } = await context.params;
        const sql = getSql();
        const session = await requireRole(sql, request, config.write);

        if (
          config.entity !== 'products' &&
          config.entity !== 'raw_materials' &&
          config.entity !== 'composite_products'
        ) {
          return jsonResponse({ error: 'DELETE_NOT_SUPPORTED' }, { status: 405 });
        }

        const row = await deactivateEntity(sql, config.entity, id, session.userId);
        return jsonResponse({ row, deactivated: true });
      } catch (error) {
        return handleError(error);
      }
    },
  };
}
