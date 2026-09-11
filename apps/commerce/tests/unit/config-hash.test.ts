import { describe, expect, it } from 'vitest';
import { canonicalizeSlotMap, canonicalJson, configHash } from '@/lib/config-hash';

const BOX = '22222222-0000-4000-8000-000000000001';
const ORANGE = '11111111-0000-4000-8000-000000000001';
const LEMON = '11111111-0000-4000-8000-000000000002';

describe('canonicalizeSlotMap', () => {
  it('sorts by slot_index', () => {
    const result = canonicalizeSlotMap([
      { slot_index: 3, raw_material_id: ORANGE },
      { slot_index: 0, raw_material_id: LEMON },
    ]);
    expect(result.map((e) => e.slot_index)).toEqual([0, 3]);
  });

  it('materialises the implicit qty of 1', () => {
    const [entry] = canonicalizeSlotMap([{ slot_index: 0, raw_material_id: ORANGE }]);
    expect(entry?.qty).toBe(1);
  });
});

describe('configHash', () => {
  it('is stable across slot ordering', async () => {
    const a = await configHash(BOX, [
      { slot_index: 0, raw_material_id: ORANGE },
      { slot_index: 1, raw_material_id: LEMON },
    ]);
    const b = await configHash(BOX, [
      { slot_index: 1, raw_material_id: LEMON },
      { slot_index: 0, raw_material_id: ORANGE },
    ]);
    expect(a).toBe(b);
  });

  it('is stable across an explicit vs implicit qty of 1', async () => {
    const implicit = await configHash(BOX, [{ slot_index: 0, raw_material_id: ORANGE }]);
    const explicit = await configHash(BOX, [
      { slot_index: 0, raw_material_id: ORANGE, qty: 1 },
    ]);
    expect(implicit).toBe(explicit);
  });

  it('is stable across uuid casing', async () => {
    const lower = await configHash(BOX, [{ slot_index: 0, raw_material_id: ORANGE }]);
    const upper = await configHash(BOX.toUpperCase(), [
      { slot_index: 0, raw_material_id: ORANGE.toUpperCase() },
    ]);
    expect(lower).toBe(upper);
  });

  it('changes when any material changes', async () => {
    const a = await configHash(BOX, [{ slot_index: 0, raw_material_id: ORANGE }]);
    const b = await configHash(BOX, [{ slot_index: 0, raw_material_id: LEMON }]);
    expect(a).not.toBe(b);
  });

  it('changes when a material moves to a different slot', async () => {
    const a = await configHash(BOX, [{ slot_index: 0, raw_material_id: ORANGE }]);
    const b = await configHash(BOX, [{ slot_index: 1, raw_material_id: ORANGE }]);
    expect(a).not.toBe(b);
  });

  it('changes when quantity changes', async () => {
    const a = await configHash(BOX, [{ slot_index: 0, raw_material_id: ORANGE, qty: 1 }]);
    const b = await configHash(BOX, [{ slot_index: 0, raw_material_id: ORANGE, qty: 2 }]);
    expect(a).not.toBe(b);
  });

  it('emits the sha256: prefixed form the contract expects', async () => {
    const hash = await configHash(BOX, [{ slot_index: 0, raw_material_id: ORANGE }]);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('canonicalJson', () => {
  it('produces a fixed key order regardless of input key order', () => {
    const json = canonicalJson(BOX, [{ qty: 2, raw_material_id: ORANGE, slot_index: 0 }]);
    expect(json).toBe(
      `${BOX}|[{"slot_index":0,"raw_material_id":"${ORANGE}","qty":2}]`,
    );
  });
});
