/**
 * Zod contracts shared by the configurator, the cart API and (in P3) webhook
 * parsing. One schema, so the client cannot send a shape the server did not
 * expect and the server cannot drift from what the client builds.
 */
import { z } from 'zod';
import { CONFIG_HASH_PATTERN } from './config-hash';
import { giftDetailsSchema } from './gifting';

export const uuidSchema = z.string().uuid();

export const slotEntrySchema = z.object({
  slot_index: z.number().int().min(0).max(11),
  raw_material_id: uuidSchema,
  qty: z.number().int().min(1).max(12).default(1),
});

export const slotMapSchema = z
  .array(slotEntrySchema)
  .min(1, 'At least one slot must be filled')
  .max(12)
  .superRefine((entries, ctx) => {
    const seen = new Set<number>();
    for (const entry of entries) {
      if (seen.has(entry.slot_index)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate slot_index ${entry.slot_index}`,
          path: [],
        });
        return;
      }
      seen.add(entry.slot_index);
    }
  });

/** Baisa arriving as JSON: accept string or number, never a float. */
export const baisaSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);

export const priceRequestSchema = z.object({
  composite_product_id: uuidSchema,
  slot_map: slotMapSchema,
  locale: z.enum(['ar', 'en']).default('en'),
});

export const configHashSchema = z.string().regex(CONFIG_HASH_PATTERN, 'Malformed config hash');

export const addCompositeItemSchema = z.object({
  type: z.literal('composite'),
  composite_product_id: uuidSchema,
  slot_map: slotMapSchema,
  config_hash: configHashSchema,
  /**
   * Advisory only. The server recomputes the price and rejects the request on
   * mismatch; it never charges what the client asked to be charged.
   */
  client_estimate: z
    .object({
      unit_price_baisa: baisaSchema,
      total_weight_grams: z.number().int().positive(),
    })
    .optional(),
  qty: z.number().int().min(1).max(50).default(1),
});

export const addProductItemSchema = z.object({
  type: z.literal('product'),
  product_id: uuidSchema,
  qty: z.number().int().min(1).max(50).default(1),
});

export const addCartItemSchema = z.discriminatedUnion('type', [
  addCompositeItemSchema,
  addProductItemSchema,
]);

export const createCartSchema = z.object({
  anon_token: z.string().min(16).max(128).optional(),
});

export const checkoutSessionSchema = z.object({
  cart_id: uuidSchema,
  /** Governorate name as seeded in `shipping_zones.governorates`. */
  governorate: z.string().trim().min(2).max(80),
  payment_method: z.enum(['card', 'cod']).default('card'),
  locale: z.enum(['ar', 'en']).default('en'),
  gift: giftDetailsSchema.optional(),
});

export type SlotMapInput = z.infer<typeof slotMapSchema>;
export type PriceRequest = z.infer<typeof priceRequestSchema>;
export type AddCartItem = z.infer<typeof addCartItemSchema>;
export type CheckoutSessionRequest = z.infer<typeof checkoutSessionSchema>;
