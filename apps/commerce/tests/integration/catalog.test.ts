/**
 * The configurator renders directly from these shapes, so a drift in the
 * `position` JSONB or in how availability is derived breaks the 3D scene with
 * no type error to catch it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getSql, closeSql } from '@/lib/db';
import { loadCompositeProduct, loadMaterials } from '@/lib/repositories/catalog';
import { hydrateProduct, hydrateMaterial } from '@/lib/configurator/types';

const DATABASE_URL = process.env['DATABASE_URL'];
const suite = DATABASE_URL ? describe : describe.skip;

let sql: postgres.Sql;

suite('catalog', () => {
  beforeAll(() => {
    sql = getSql();
  });
  afterAll(async () => {
    await closeSql();
  });

  it('loads the box with four ordered slots', async () => {
    const wire = await loadCompositeProduct(sql, 'custom-box-4');
    expect(wire).not.toBeNull();

    const product = hydrateProduct(wire!);
    expect(product.kind).toBe('box');
    expect(product.base_price_baisa).toBe(2500n);
    expect(product.slots).toHaveLength(4);
    expect(product.slots.map((s) => s.slot_index)).toEqual([0, 1, 2, 3]);
  });

  it('returns slot positions as usable 3D vectors', async () => {
    const wire = await loadCompositeProduct(sql, 'custom-box-4');
    for (const slot of wire!.slots) {
      expect(typeof slot.position.x).toBe('number');
      expect(typeof slot.position.y).toBe('number');
      expect(typeof slot.position.z).toBe('number');
    }
    // The four box slots must occupy distinct positions, or they stack.
    const unique = new Set(wire!.slots.map((s) => `${s.position.x},${s.position.z}`));
    expect(unique.size).toBe(4);
  });

  it('carries the bouquet rose-only rings and required slots', async () => {
    const wire = await loadCompositeProduct(sql, 'rose-bouquet-6');
    const product = hydrateProduct(wire!);

    expect(product.kind).toBe('bouquet');
    expect(product.min_filled_slots).toBe(3);
    expect(product.slots.filter((s) => s.is_required).map((s) => s.slot_index)).toEqual([0, 1]);
    expect(
      product.slots.filter((s) => s.allowed_categories.includes('rose')).map((s) => s.slot_index),
    ).toEqual([4, 5]);
  });

  it('returns null for an unknown slug rather than throwing', async () => {
    expect(await loadCompositeProduct(sql, 'does-not-exist')).toBeNull();
  });

  it('exposes availability, not raw stock columns', async () => {
    const materials = (await loadMaterials(sql)).map(hydrateMaterial);
    expect(materials.length).toBeGreaterThan(0);

    for (const material of materials) {
      expect(material.available).toBeGreaterThanOrEqual(0);
      expect(typeof material.unit_price_baisa).toBe('bigint');
      // Nothing that would leak inventory levels.
      expect(material).not.toHaveProperty('stock_qty');
      expect(material).not.toHaveProperty('reserved_qty');
    }
  });

  it('reflects reservations in availability', async () => {
    const findLemon = async () =>
      (await loadMaterials(sql)).find((m) => m.sku === 'CIT-LEMON')!;

    const before = await findLemon();

    const [lemon] = await sql<{ id: string }[]>`
      select id from raw_materials where sku = 'CIT-LEMON'
    `;
    const [box] = await sql<{ id: string }[]>`
      select id from composite_products where slug = 'custom-box-4'
    `;
    const [cart] = await sql<{ id: string }[]>`
      insert into carts (anon_token) values (${crypto.randomUUID()}) returning id
    `;
    const [config] = await sql<{ id: string }[]>`
      select (c).id from upsert_configuration(
        ${box!.id},
        ${sql.json([{ slot_index: 0, raw_material_id: lemon!.id, qty: 1 }])}::jsonb,
        ${`sha256:${'b'.repeat(64)}`},
        null
      ) as c
    `;

    await sql`select reserve_configuration(${cart!.id}, ${config!.id}, 5)`;

    const after = await findLemon();
    expect(after.available).toBe(before.available - 5);
  });
});
