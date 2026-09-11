import { getSql } from '@/lib/db';
import { uuidSchema } from '@/lib/contracts';
import { removeCartItem } from '@/lib/repositories/carts';
import { errorResponse, validationResponse } from '@/lib/errors';
import { jsonResponse } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ cartId: string; itemId: string }>;
}

/** Removing a composite line releases its stock hold in the same transaction. */
export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const { cartId, itemId } = await context.params;
  if (!uuidSchema.safeParse(cartId).success || !uuidSchema.safeParse(itemId).success) {
    return validationResponse([{ message: 'Malformed id' }]);
  }

  try {
    await removeCartItem(getSql(), cartId, itemId);
    return jsonResponse({ removed: true });
  } catch (error) {
    return errorResponse(error);
  }
}
