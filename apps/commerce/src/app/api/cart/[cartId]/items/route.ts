import { getSql } from '@/lib/db';
import { addCartItemSchema, uuidSchema } from '@/lib/contracts';
import { addCompositeItem, addProductItem, getCart } from '@/lib/repositories/carts';
import { errorResponse, validationResponse } from '@/lib/errors';
import { jsonResponse, readJson } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ cartId: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { cartId } = await context.params;
  if (!uuidSchema.safeParse(cartId).success) {
    return validationResponse([{ message: 'Malformed cart id' }]);
  }

  try {
    const cart = await getCart(getSql(), cartId);
    if (!cart) {
      return jsonResponse({ error: 'CART_NOT_FOUND' }, { status: 404 });
    }
    return jsonResponse(cart);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Adds a line to the cart.
 *
 * For a composite build this also takes the stock reservation. The client's
 * `client_estimate` is advisory: the server prices the build from
 * `raw_materials` and returns its own number, so a tampered payload buys
 * nothing.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { cartId } = await context.params;
  if (!uuidSchema.safeParse(cartId).success) {
    return validationResponse([{ message: 'Malformed cart id' }]);
  }

  const parsed = addCartItemSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return validationResponse(parsed.error.issues);
  }

  try {
    const sql = getSql();

    // Each add takes a stock reservation, so this is the endpoint an attacker
    // would use to hold the whole catalogue hostage.
    const limited = await enforceRateLimit(sql, 'cartMutate', request, cartId);
    if (limited) return limited;

    if (parsed.data.type === 'product') {
      const result = await addProductItem(sql, {
        cartId,
        productId: parsed.data.product_id,
        qty: parsed.data.qty,
      });
      return jsonResponse(result, { status: 201 });
    }

    const result = await addCompositeItem(sql, {
      cartId,
      compositeProductId: parsed.data.composite_product_id,
      slotMap: parsed.data.slot_map,
      configHash: parsed.data.config_hash,
      qty: parsed.data.qty,
    });

    const estimate = parsed.data.client_estimate;
    const repriced =
      estimate !== undefined && BigInt(estimate.unit_price_baisa) !== result.unit_price_baisa;

    return jsonResponse({ ...result, repriced }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
