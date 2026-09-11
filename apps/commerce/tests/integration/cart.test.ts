/**
 * Cart repository against a real database: pricing, reservation coupling,
 * deduplication and hash tampering.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getSql, closeSql } from '@/lib/db';
import {
  addCompositeItem,
  addProductItem,
  createCart,
  getCart,
  removeCartItem,
} from '@/lib/repositories/carts';
import { priceConfiguration } from '@/lib/repositories/configurations';
import { configHash } from '@/lib/config-hash';

const DATABASE_URL = process.env['DATABASE_URL'];
const suite = DATABASE_URL ? describe : describe.skip;

const BOX = '22222222-0000-4000-8000-000000000001';
const BOUQUET = '22222222-0000-4000-8000-000000000002';
const ORANGE = '11111111-0000-4000-8000-000000000001';
const DARK_CHOCOLATE = '11111111-0000-4000-8000-000000000003';
const ROSE = '11111111-0000-4000-8000-000000000007';

const TWO_SLOT_BOX = [
  { slot_index: 0, raw_material_id: ORANGE },
  { slot_index: 1, raw_material_id: DARK_CHOCOLATE },
];

let sql: postgres.Sql;

async function reservedQty(id: string): Promise<number> {
  const [row] = await sql<{ reserved_qty: number }[]>`
    select reserved_qty from raw_materials where id = ${id}
  `;
  return row!.reserved_qty;
}

suite('cart', () => {
  beforeAll(() => {
    sql = getSql();
  });

  afterAll(async () => {
    await closeSql();
  });

  it('prices a build from raw materials, not from the client', async () => {
    const pricing = await priceConfiguration(sql, BOX, TWO_SLOT_BOX);
    // 2500 base + 750 candied orange + 1250 dark chocolate
    expect(pricing.unit_price_baisa).toBe(4500n);
    // 180g base + 45g + 60g
    expect(pricing.total_weight_grams).toBe(285);
    expect(pricing.filled_slots).toBe(2);
  });

  it('merges an identical build into one line and reserves per unit', async () => {
    const hash = await configHash(BOX, TWO_SLOT_BOX);
    const cart = await createCart(sql, { anonToken: crypto.randomUUID() });
    const before = await reservedQty(ORANGE);

    await addCompositeItem(sql, {
      cartId: cart.id, compositeProductId: BOX, slotMap: TWO_SLOT_BOX, configHash: hash, qty: 2,
    });
    await addCompositeItem(sql, {
      cartId: cart.id, compositeProductId: BOX, slotMap: TWO_SLOT_BOX, configHash: hash, qty: 1,
    });

    const summary = await getCart(sql, cart.id);
    expect(summary!.items).toHaveLength(1);
    expect(summary!.items[0]!.qty).toBe(3);
    expect(summary!.subtotal_baisa).toBe(13_500n);
    expect(summary!.total_weight_grams).toBe(855);
    expect(await reservedQty(ORANGE)).toBe(before + 3);
  });

  it('releases the hold when the line is removed', async () => {
    const hash = await configHash(BOX, TWO_SLOT_BOX);
    const cart = await createCart(sql, { anonToken: crypto.randomUUID() });
    const before = await reservedQty(ORANGE);

    const added = await addCompositeItem(sql, {
      cartId: cart.id, compositeProductId: BOX, slotMap: TWO_SLOT_BOX, configHash: hash, qty: 2,
    });
    expect(await reservedQty(ORANGE)).toBe(before + 2);

    await removeCartItem(sql, cart.id, added.item_id);

    expect(await reservedQty(ORANGE)).toBe(before);
    expect((await getCart(sql, cart.id))!.items).toHaveLength(0);
  });

  it('keeps the holds of sibling lines when one is removed', async () => {
    const cart = await createCart(sql, { anonToken: crypto.randomUUID() });
    const keptSlotMap = [{ slot_index: 0, raw_material_id: DARK_CHOCOLATE }];

    const removed = await addCompositeItem(sql, {
      cartId: cart.id, compositeProductId: BOX, slotMap: TWO_SLOT_BOX,
      configHash: await configHash(BOX, TWO_SLOT_BOX), qty: 1,
    });
    await addCompositeItem(sql, {
      cartId: cart.id, compositeProductId: BOX, slotMap: keptSlotMap,
      configHash: await configHash(BOX, keptSlotMap), qty: 4,
    });

    const chocolateBefore = await reservedQty(DARK_CHOCOLATE);
    const orangeBefore = await reservedQty(ORANGE);
    await removeCartItem(sql, cart.id, removed.item_id);

    // The removed line held 1 chocolate and 1 orange; the surviving line's 4
    // chocolates must still be held. Assertions are relative because other
    // tests in this file legitimately leave holds in place.
    expect(await reservedQty(DARK_CHOCOLATE)).toBe(chocolateBefore - 1);
    expect(await reservedQty(ORANGE)).toBe(orangeBefore - 1);
  });

  it('rejects a tampered config hash', async () => {
    const cart = await createCart(sql, { anonToken: crypto.randomUUID() });
    await expect(
      addCompositeItem(sql, {
        cartId: cart.id, compositeProductId: BOX, slotMap: TWO_SLOT_BOX,
        configHash: `sha256:${'0'.repeat(64)}`, qty: 1,
      }),
    ).rejects.toThrow(/HASH_MISMATCH/);
  });

  it('rejects a material the slot does not allow', async () => {
    // Bouquet ring 4 accepts roses only.
    const slotMap = [
      { slot_index: 0, raw_material_id: ROSE },
      { slot_index: 1, raw_material_id: ROSE },
      { slot_index: 4, raw_material_id: ORANGE },
    ];
    await expect(
      priceConfiguration(sql, BOUQUET, slotMap),
    ).rejects.toThrow(/CATEGORY_NOT_ALLOWED/);
  });

  it('rejects a build that leaves a required slot empty', async () => {
    // Bouquet slots 0 and 1 are required.
    const slotMap = [
      { slot_index: 0, raw_material_id: ORANGE },
      { slot_index: 2, raw_material_id: ORANGE },
      { slot_index: 3, raw_material_id: ORANGE },
    ];
    await expect(
      priceConfiguration(sql, BOUQUET, slotMap),
    ).rejects.toThrow(/REQUIRED_SLOT_EMPTY/);
  });

  it('rejects a build below the minimum fill', async () => {
    // The bouquet requires at least 3 filled slots.
    await expect(
      priceConfiguration(sql, BOUQUET, [{ slot_index: 0, raw_material_id: ORANGE }]),
    ).rejects.toThrow(/MIN_FILL_NOT_MET/);
  });

  it('adds a standard product line', async () => {
    const cart = await createCart(sql, { anonToken: crypto.randomUUID() });
    const [product] = await sql<{ id: string; price_baisa: string }[]>`
      select id, price_baisa from products where slug = 'classic-halwa-tin'
    `;

    await addProductItem(sql, { cartId: cart.id, productId: product!.id, qty: 2 });

    const summary = await getCart(sql, cart.id);
    expect(summary!.items).toHaveLength(1);
    expect(summary!.items[0]!.product_id).toBe(product!.id);
    expect(summary!.subtotal_baisa).toBe(BigInt(product!.price_baisa) * 2n);
  });
});
