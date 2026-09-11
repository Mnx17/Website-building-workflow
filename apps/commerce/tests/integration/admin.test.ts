/**
 * Admin API: role gating, the audit trail, rate limiting and the review queue.
 *
 * Route Handlers are called directly, so the real auth path runs — a JWT is
 * minted with the configured secret and the role is read from `staff_users`.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getSql, closeSql } from '@/lib/db';
import { GET as productsGet, POST as productsPost } from '@/app/api/admin/products/route';
import { PATCH as productPatch } from '@/app/api/admin/products/[id]/route';
import { PATCH as materialPatch } from '@/app/api/admin/materials/[id]/route';
import {
  GET as inventoryGet,
  POST as inventoryPost,
} from '@/app/api/admin/inventory/route';
import { GET as auditGet } from '@/app/api/admin/audit/route';
import { PATCH as themePatch, GET as themeGet } from '@/app/api/admin/theme/route';
import { checkRateLimit } from '@/lib/rate-limit';
import { loadActiveTheme } from '@/lib/theme';

const DATABASE_URL = process.env['DATABASE_URL'];
const suite = DATABASE_URL ? describe : describe.skip;

const SECRET = 'test-jwt-secret-for-admin-suite';
const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const EDITOR_ID = '00000000-0000-4000-8000-0000000000a2';
const FULFILMENT_ID = '00000000-0000-4000-8000-0000000000a3';
const OUTSIDER_ID = '00000000-0000-4000-8000-0000000000a4';

let sql: postgres.Sql;

function jwt(sub: string, secret = SECRET): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function req(
  url: string,
  options: { as?: string; method?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.as) headers['authorization'] = `Bearer ${jwt(options.as)}`;

  return new Request(`http://localhost${url}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

suite('admin API', () => {
  beforeAll(async () => {
    process.env['SUPABASE_JWT_SECRET'] = SECRET;
    sql = getSql();

    // Seed auth users and their staff roles.
    for (const [id, role] of [
      [ADMIN_ID, 'admin'],
      [EDITOR_ID, 'editor'],
      [FULFILMENT_ID, 'fulfillment'],
    ] as const) {
      await sql`
        insert into auth.users (id, email) values (${id}, ${`${role}@example.com`})
        on conflict (id) do nothing
      `;
      await sql`
        insert into staff_users (user_id, role) values (${id}, ${role}::staff_role)
        on conflict (user_id) do update set role = excluded.role
      `;
    }
    // A signed-in user who is not staff at all.
    await sql`
      insert into auth.users (id, email) values (${OUTSIDER_ID}, 'nobody@example.com')
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    await closeSql();
  });

  describe('authentication', () => {
    it('refuses an unauthenticated request', async () => {
      const response = await productsGet(req('/api/admin/products'));
      expect(response.status).toBe(401);
    });

    it('refuses a token signed with the wrong secret', async () => {
      const bad = new Request('http://localhost/api/admin/products', {
        headers: { authorization: `Bearer ${jwt(ADMIN_ID, 'not-the-secret')}` },
      });
      expect((await productsGet(bad)).status).toBe(401);
    });

    it('refuses an authenticated user who is not staff', async () => {
      const response = await productsGet(req('/api/admin/products', { as: OUTSIDER_ID }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'NOT_STAFF' });
    });

    it('fails closed when no JWT secret is configured', async () => {
      const saved = process.env['SUPABASE_JWT_SECRET'];
      delete process.env['SUPABASE_JWT_SECRET'];
      try {
        const response = await productsGet(req('/api/admin/products', { as: ADMIN_ID }));
        // Not 200. An unconfigured deploy must not become an open admin panel.
        expect(response.status).toBe(503);
      } finally {
        process.env['SUPABASE_JWT_SECRET'] = saved;
      }
    });

    it('lets staff read', async () => {
      const response = await productsGet(req('/api/admin/products', { as: FULFILMENT_ID }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { rows: unknown[] };
      expect(Array.isArray(body.rows)).toBe(true);
    });
  });

  describe('role separation', () => {
    it('lets an editor create a product', async () => {
      const response = await productsPost(
        req('/api/admin/products', {
          as: EDITOR_ID,
          method: 'POST',
          body: {
            slug: `test-${crypto.randomUUID()}`,
            name_en: 'Test Product',
            name_ar: 'منتج اختبار',
            price_baisa: 5000,
            weight_grams: 300,
          },
        }),
      );
      expect(response.status).toBe(201);
    });

    it('refuses a fulfilment user writing to the catalogue', async () => {
      const response = await productsPost(
        req('/api/admin/products', {
          as: FULFILMENT_ID,
          method: 'POST',
          body: { slug: 'nope', name_en: 'x', name_ar: 'x', price_baisa: 1, weight_grams: 1 },
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'INSUFFICIENT_ROLE' });
    });

    it('reserves the audit trail for admins', async () => {
      expect((await auditGet(req('/api/admin/audit', { as: EDITOR_ID }))).status).toBe(403);
      expect((await auditGet(req('/api/admin/audit', { as: ADMIN_ID }))).status).toBe(200);
    });

    it('reserves theme changes for admins', async () => {
      const [theme] = await sql<{ id: string }[]>`select id from themes limit 1`;
      const response = await themePatch(
        req('/api/admin/theme', {
          as: EDITOR_ID,
          method: 'PATCH',
          body: { id: theme!.id, fields: { name: 'Hijacked' } },
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe('write protection', () => {
    it('ignores fields that are not writable', async () => {
      const [product] = await sql<{ id: string }[]>`select id from products limit 1`;
      const response = await productPatch(
        req(`/api/admin/products/${product!.id}`, {
          as: EDITOR_ID,
          method: 'PATCH',
          body: { name_en: 'Renamed', id: '99999999-9999-4999-8999-999999999999' },
        }),
        { params: Promise.resolve({ id: product!.id }) },
      );
      expect(response.status).toBe(200);

      const [after] = await sql<{ id: string; name_en: string }[]>`
        select id, name_en from products where id = ${product!.id}
      `;
      expect(after!.name_en).toBe('Renamed');
      expect(after!.id).toBe(product!.id); // primary key untouched
    });

    it('refuses to write stock directly, so the ledger cannot drift', async () => {
      const [material] = await sql<{ id: string }[]>`select id from raw_materials limit 1`;
      const response = await materialPatch(
        req(`/api/admin/materials/${material!.id}`, {
          as: EDITOR_ID,
          method: 'PATCH',
          body: { stock_qty: 99999 },
        }),
        { params: Promise.resolve({ id: material!.id }) },
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: 'STOCK_NOT_DIRECTLY_WRITABLE' });
    });

    it('reports a duplicate slug as a conflict, not a crash', async () => {
      const slug = `dupe-${crypto.randomUUID()}`;
      const body = {
        slug,
        name_en: 'Dupe',
        name_ar: 'مكرر',
        price_baisa: 1000,
        weight_grams: 100,
      };
      expect(
        (await productsPost(req('/api/admin/products', { as: EDITOR_ID, method: 'POST', body })))
          .status,
      ).toBe(201);
      expect(
        (await productsPost(req('/api/admin/products', { as: EDITOR_ID, method: 'POST', body })))
          .status,
      ).toBe(409);
    });
  });

  describe('audit trail', () => {
    it('records who changed what, with before and after', async () => {
      const [product] = await sql<{ id: string; name_en: string }[]>`
        select id, name_en from products limit 1
      `;
      const newName = `Audited ${Date.now()}`;

      await productPatch(
        req(`/api/admin/products/${product!.id}`, {
          as: EDITOR_ID,
          method: 'PATCH',
          body: { name_en: newName },
        }),
        { params: Promise.resolve({ id: product!.id }) },
      );

      const [entry] = await sql<
        {
          actor_user_id: string;
          action: string;
          before: { name_en: string };
          after: { name_en: string };
        }[]
      >`
        select actor_user_id, action, before, after
          from admin_audit_log
         where entity = 'products' and entity_id = ${product!.id}
         order by id desc limit 1
      `;

      expect(entry!.actor_user_id).toBe(EDITOR_ID);
      expect(entry!.action).toBe('update');
      expect(entry!.after.name_en).toBe(newName);
      expect(entry!.before.name_en).not.toBe(newName);
    });

    it('cannot be rewritten or deleted', async () => {
      const [before] = await sql<{ count: string }[]>`select count(*) from admin_audit_log`;
      await sql`update admin_audit_log set actor_user_id = null`;
      await sql`delete from admin_audit_log`;
      const [after] = await sql<{ count: string }[]>`select count(*) from admin_audit_log`;
      expect(after!.count).toBe(before!.count);
    });
  });

  describe('inventory', () => {
    it('adjusts stock through the ledger and keeps it reconciled', async () => {
      const [material] = await sql<{ id: string; stock_qty: number }[]>`
        select id, stock_qty from raw_materials where sku = 'HAL-CLASSIC'
      `;

      const response = await inventoryPost(
        req('/api/admin/inventory', {
          as: EDITOR_ID,
          method: 'POST',
          body: {
            raw_material_id: material!.id,
            delta: -5,
            reason: 'spoilage',
            note: 'water damage in storage',
          },
        }),
      );
      expect(response.status).toBe(200);

      const [after] = await sql<{ stock_qty: number; ledger_sum: string }[]>`
        select m.stock_qty, coalesce(sum(l.delta_stock_qty), 0) as ledger_sum
          from raw_materials m
          left join inventory_ledger l on l.raw_material_id = m.id
         where m.id = ${material!.id}
         group by m.stock_qty
      `;
      expect(after!.stock_qty).toBe(material!.stock_qty - 5);
      expect(Number(after!.ledger_sum)).toBe(after!.stock_qty);
    });

    it('requires an explanation for a manual adjustment', async () => {
      const [material] = await sql<{ id: string }[]>`select id from raw_materials limit 1`;
      const response = await inventoryPost(
        req('/api/admin/inventory', {
          as: EDITOR_ID,
          method: 'POST',
          body: { raw_material_id: material!.id, delta: 10, reason: 'restock' },
        }),
      );
      expect(response.status).toBe(400);
    });

    it('exposes low stock and the ledger to fulfilment', async () => {
      const response = await inventoryGet(req('/api/admin/inventory', { as: FULFILMENT_ID }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { low_stock: unknown[]; ledger: unknown[] };
      expect(Array.isArray(body.low_stock)).toBe(true);
      expect(body.ledger.length).toBeGreaterThan(0);
    });
  });

  describe('theme', () => {
    it('activates exactly one theme atomically', async () => {
      const created = await sql<{ id: string }[]>`
        insert into themes (name, primary_color, secondary_color, font_family)
        values ('Eid', '#7A1F3D', '#E8B84B', 'Cairo')
        returning id
      `;

      const response = await themePatch(
        req('/api/admin/theme', {
          as: ADMIN_ID,
          method: 'PATCH',
          body: { id: created[0]!.id, activate: true },
        }),
      );
      expect(response.status).toBe(200);

      const [count] = await sql<{ count: string }[]>`
        select count(*) from themes where is_active
      `;
      expect(Number(count!.count)).toBe(1);

      const active = await loadActiveTheme(sql);
      expect(active.id).toBe(created[0]!.id);
      expect(active.primary_color).toBe('#7A1F3D');
    });

    it('rejects a font without Arabic coverage', async () => {
      const [theme] = await sql<{ id: string }[]>`select id from themes limit 1`;
      const response = await themePatch(
        req('/api/admin/theme', {
          as: ADMIN_ID,
          method: 'PATCH',
          body: { id: theme!.id, fields: { font_family: 'Comic Sans MS' } },
        }),
      );
      expect(response.status).toBe(400);
    });

    it('lists only Arabic-capable fonts as options', async () => {
      const response = await themeGet(req('/api/admin/theme', { as: ADMIN_ID }));
      const body = (await response.json()) as { fonts: string[] };
      expect(body.fonts).toContain('Tajawal');
      expect(body.fonts).not.toContain('Comic Sans MS');
    });
  });

  describe('rate limiting', () => {
    it('counts hits per bucket and trips at the limit', async () => {
      const identifier = `test-${crypto.randomUUID()}`;
      let last = await checkRateLimit(sql, 'checkout', identifier);

      for (let i = 1; i < 10; i++) {
        last = await checkRateLimit(sql, 'checkout', identifier);
      }
      expect(last.allowed).toBe(true);
      expect(last.hits).toBe(10);

      const over = await checkRateLimit(sql, 'checkout', identifier);
      expect(over.allowed).toBe(false);
      expect(over.hits).toBe(11);
    });

    it('keeps separate identifiers independent', async () => {
      const a = `a-${crypto.randomUUID()}`;
      const b = `b-${crypto.randomUUID()}`;
      for (let i = 0; i < 11; i++) await checkRateLimit(sql, 'checkout', a);

      const other = await checkRateLimit(sql, 'checkout', b);
      expect(other.allowed).toBe(true);
      expect(other.hits).toBe(1);
    });

    it('purges old windows', async () => {
      await sql`
        insert into rate_limits (bucket, window_start, hits)
        values ('stale', now() - interval '3 days', 5)
        on conflict do nothing
      `;
      const [purged] = await sql<{ purge_rate_limits: number }[]>`select purge_rate_limits()`;
      expect(purged!.purge_rate_limits).toBeGreaterThanOrEqual(1);
    });
  });
});
