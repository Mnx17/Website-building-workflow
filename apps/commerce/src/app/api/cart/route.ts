import { getSql } from '@/lib/db';
import { createCartSchema } from '@/lib/contracts';
import { createCart } from '@/lib/repositories/carts';
import { errorResponse, validationResponse } from '@/lib/errors';
import { jsonResponse, readJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) ?? {};
  const parsed = createCartSchema.safeParse(body);
  if (!parsed.success) {
    return validationResponse(parsed.error.issues);
  }

  try {
    const sql = getSql();
    // P1 has no auth wiring yet; carts are anonymous until P3 attaches a user.
    const cart = await createCart(sql, { anonToken: parsed.data.anon_token ?? null });
    return jsonResponse({ cart_id: cart.id }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
