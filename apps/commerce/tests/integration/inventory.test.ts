/**
 * P1 exit criteria, executed against a real PostgreSQL 15.
 *
 *   DATABASE_URL=postgres://... npm run db:reset && npm run test:integration
 *
 * Skipped (not failed) when DATABASE_URL is absent, so `npm test` stays green
 * on a machine without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { configHash } from '@/lib/config-hash';

const DATABASE_URL = process.env['DATABASE_URL'];
const suite = DATABASE_URL ? describe : describe.skip;

const BOX = '22222222-0000-4000-8000-000000000001';
const ORANGE = '11111111-0000-4000-8000-000000000001';
const LEMON = '11111111-0000-4000-8000-000000000002';

const CONCURRENCY = 50;

let sql: postgres.Sql;

// One client for the whole file. Opening it per suite and closing it in the
// first suite's afterAll leaves later suites querying a dead connection.
beforeAll(() => {
  sql = postgres(DATABASE_URL!, { max: CONCURRENCY + 5, prepare: false, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function newCart(): Promise<string> {
  const [cart] = await sql<{ id: string }[]>`
    insert into carts (anon_token) values (${crypto.randomUUID()}) returning id
  `;
  return cart!.id;
}

async function makeConfiguration(slotMap: { slot_index: number; raw_material_id: string }[]) {
  const hash = await configHash(BOX, slotMap);
  const [row] = await sql<{ id: string }[]>`
    select (c).id from upsert_configuration(
      ${BOX}, ${sql.json(slotMap.map((s) => ({ ...s, qty: 1 })))}::jsonb, ${hash}, null
    ) as c
  `;
  return row!.id;
}

/**
 * Creates a material owned solely by the calling test. The concurrency test
 * drains its material to zero permanently, so it must not share one with any
 * other suite — otherwise passing depends on file execution order.
 */
async function createTestMaterial(stock: number): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into raw_materials (sku, name_en, name_ar, category, unit_price_baisa, weight_grams)
    values (${`TEST-${crypto.randomUUID()}`}, 'Test', 'اختبار', 'citrus', 500, 10)
    returning id
  `;
  await sql`select adjust_stock(${row!.id}, ${stock}, 'restock', 'test fixture', null)`;
  return row!.id;
}

async function material(id: string) {
  const [row] = await sql<{ stock_qty: number; reserved_qty: number }[]>`
    select stock_qty, reserved_qty from raw_materials where id = ${id}
  `;
  return row!;
}

/** The invariant the append-only ledger exists to guarantee. */
async function assertLedgerReconciles() {
  const drift = await sql<{ id: string; stock_drift: string; reserved_drift: string }[]>`
    select m.id,
           m.stock_qty    - coalesce(sum(l.delta_stock_qty), 0)    as stock_drift,
           m.reserved_qty - coalesce(sum(l.delta_reserved_qty), 0) as reserved_drift
      from raw_materials m
      left join inventory_ledger l on l.raw_material_id = m.id
     group by m.id, m.stock_qty, m.reserved_qty
    having m.stock_qty    - coalesce(sum(l.delta_stock_qty), 0)    <> 0
        or m.reserved_qty - coalesce(sum(l.delta_reserved_qty), 0) <> 0
  `;
  expect(drift).toEqual([]);
}

suite('inventory reservation under concurrency', () => {
  it('seed data already reconciles', async () => {
    await assertLedgerReconciles();
  });

  it('sells the last unit exactly once across 50 concurrent carts', async () => {
    // One unit, in a material no other test touches.
    const scarce = await createTestMaterial(1);
    const configId = await makeConfiguration([{ slot_index: 0, raw_material_id: scarce }]);
    const carts = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => newCart()),
    );

    const outcomes = await Promise.allSettled(
      carts.map((cartId) => sql`select reserve_configuration(${cartId}, ${configId}, 1)`),
    );

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENCY - 1);
    for (const failure of rejected) {
      expect(String(failure.reason?.message)).toContain('OUT_OF_STOCK');
    }

    const after = await material(scarce);
    expect(after.stock_qty - after.reserved_qty).toBe(0);
    expect(after.reserved_qty).toBeLessThanOrEqual(after.stock_qty);

    await assertLedgerReconciles();
  });

  it('releases a hold idempotently', async () => {
    const configId = await makeConfiguration([{ slot_index: 0, raw_material_id: LEMON }]);
    const cartId = await newCart();

    const before = await material(LEMON);
    await sql`select reserve_configuration(${cartId}, ${configId}, 3)`;
    expect((await material(LEMON)).reserved_qty).toBe(before.reserved_qty + 3);

    await sql`select release_cart_reservations(${cartId})`;
    await sql`select release_cart_reservations(${cartId})`; // second call is a no-op

    expect((await material(LEMON)).reserved_qty).toBe(before.reserved_qty);
    await assertLedgerReconciles();
  });

  it('sweeps expired reservations', async () => {
    const configId = await makeConfiguration([{ slot_index: 0, raw_material_id: LEMON }]);
    const cartId = await newCart();
    const before = await material(LEMON);

    await sql`select reserve_configuration(${cartId}, ${configId}, 2)`;
    await sql`update carts set reserved_until = now() - interval '1 minute' where id = ${cartId}`;

    const [swept] = await sql<{ release_expired_reservations: number }[]>`
      select release_expired_reservations()
    `;
    expect(swept!.release_expired_reservations).toBeGreaterThanOrEqual(1);
    expect((await material(LEMON)).reserved_qty).toBe(before.reserved_qty);
    await assertLedgerReconciles();
  });

  it('commits stock exactly once even when the webhook is replayed', async () => {
    const configId = await makeConfiguration([{ slot_index: 0, raw_material_id: LEMON }]);
    const cartId = await newCart();
    const before = await material(LEMON);

    await sql`select reserve_configuration(${cartId}, ${configId}, 2)`;

    const [order] = await sql<{ id: string }[]>`
      insert into orders (cart_id, subtotal_baisa, total_baisa, total_weight_grams)
      values (${cartId}, 1000, 1000, 100)
      returning id
    `;

    const results: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = await sql<{ commit_order_stock: string }[]>`
        select commit_order_stock(${order!.id})
      `;
      results.push(row!.commit_order_stock);
    }

    expect(results[0]).toBe('committed');
    expect(results.slice(1)).toEqual(Array(4).fill('already_committed'));

    const after = await material(LEMON);
    expect(after.stock_qty).toBe(before.stock_qty - 2);
    expect(after.reserved_qty).toBe(before.reserved_qty);

    const [commits] = await sql<{ count: string }[]>`
      select count(*) from inventory_ledger
       where order_id = ${order!.id} and reason = 'commit'
    `;
    expect(Number(commits!.count)).toBe(1);

    await assertLedgerReconciles();
  });

  it('reports a lost reservation rather than overselling', async () => {
    const configId = await makeConfiguration([{ slot_index: 0, raw_material_id: LEMON }]);
    const cartId = await newCart();

    await sql`select reserve_configuration(${cartId}, ${configId}, 1)`;
    await sql`select release_cart_reservations(${cartId})`; // hold lapsed before payment

    const [order] = await sql<{ id: string }[]>`
      insert into orders (cart_id, subtotal_baisa, total_baisa, total_weight_grams)
      values (${cartId}, 1000, 1000, 100)
      returning id
    `;
    const [row] = await sql<{ commit_order_stock: string }[]>`
      select commit_order_stock(${order!.id})
    `;

    expect(row!.commit_order_stock).toBe('reservation_lost');
    await assertLedgerReconciles();
  });
});

suite('order state machine', () => {
  async function newOrder(): Promise<string> {
    const [order] = await sql<{ id: string }[]>`
      insert into orders (subtotal_baisa, total_baisa, total_weight_grams)
      values (1000, 1000, 100) returning id
    `;
    return order!.id;
  }

  it('walks the happy path', async () => {
    const id = await newOrder();
    for (const status of ['paid', 'processing', 'shipped', 'delivered']) {
      await sql`update orders set status = ${status}::order_status where id = ${id}`;
    }
    const [row] = await sql<{ status: string; paid_at: string | null }[]>`
      select status, paid_at from orders where id = ${id}
    `;
    expect(row!.status).toBe('delivered');
    expect(row!.paid_at).not.toBeNull(); // set automatically by the trigger
  });

  it('rejects a skipped transition', async () => {
    const id = await newOrder();
    await expect(
      sql`update orders set status = 'delivered' where id = ${id}`,
    ).rejects.toThrow(/ILLEGAL_TRANSITION/);
  });

  it('rejects resurrecting a cancelled order', async () => {
    const id = await newOrder();
    await sql`update orders set status = 'cancelled' where id = ${id}`;
    await expect(
      sql`update orders set status = 'paid' where id = ${id}`,
    ).rejects.toThrow(/ILLEGAL_TRANSITION/);
  });
});

suite('schema guarantees', () => {
  it('refuses overlapping shipping weight bands', async () => {
    const [zone] = await sql<{ id: string }[]>`
      select id from shipping_zones where code = 'MUSCAT'
    `;
    await expect(
      sql`insert into shipping_rates (zone_id, min_grams, max_grams, price_baisa)
          values (${zone!.id}, 500, 1500, 9999)`,
    ).rejects.toThrow(/shipping_rates_no_overlap|exclusion/i);
  });

  it('refuses a cart item that is both a product and a configuration', async () => {
    const cartId = await newCart();
    const [product] = await sql<{ id: string }[]>`select id from products limit 1`;
    const configId = await makeConfiguration([{ slot_index: 0, raw_material_id: LEMON }]);

    await expect(
      sql`insert into cart_items (cart_id, product_id, configuration_id, qty,
                                  unit_price_baisa, unit_weight_grams)
          values (${cartId}, ${product!.id}, ${configId}, 1, 100, 10)`,
    ).rejects.toThrow(/cart_item_exactly_one/);
  });

  it('silently discards attempts to rewrite ledger history', async () => {
    const [before] = await sql<{ count: string }[]>`select count(*) from inventory_ledger`;
    await sql`update inventory_ledger set note = 'tampered'`;
    await sql`delete from inventory_ledger`;
    const [after] = await sql<{ count: string }[]>`select count(*) from inventory_ledger`;

    expect(after!.count).toBe(before!.count);
    const [tampered] = await sql<{ count: string }[]>`
      select count(*) from inventory_ledger where note = 'tampered'
    `;
    expect(Number(tampered!.count)).toBe(0);
  });

  it('enforces reserved_qty <= stock_qty as a backstop', async () => {
    await expect(
      sql`update raw_materials set reserved_qty = stock_qty + 1 where id = ${LEMON}`,
    ).rejects.toThrow(/raw_materials_reserved_lte_stock/);
  });
});
