/**
 * Translates the domain errors raised by the PL/pgSQL functions into HTTP
 * responses. The database is the authority on these rules, so the mapping
 * lives in one place rather than being re-derived per route.
 *
 * Raised as `CODE:detail`, e.g. `OUT_OF_STOCK:11111111-...`.
 */

export interface DomainError {
  code: string;
  detail: string | undefined;
  status: number;
  message: string;
}

const STATUS_BY_CODE: Record<string, number> = {
  OUT_OF_STOCK: 409,
  CART_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  COMPOSITE_NOT_FOUND: 404,
  MATERIAL_NOT_FOUND: 404,
  SLOT_NOT_FOUND: 422,
  SLOT_MAP_NOT_ARRAY: 422,
  SLOT_ENTRY_MALFORMED: 422,
  SLOT_QTY_OUT_OF_RANGE: 422,
  DUPLICATE_SLOT: 422,
  CATEGORY_NOT_ALLOWED: 422,
  MIN_FILL_NOT_MET: 422,
  REQUIRED_SLOT_EMPTY: 422,
  INVALID_QTY: 422,
  ZERO_ADJUSTMENT: 422,
  INVALID_ADJUSTMENT_REASON: 422,
  ILLEGAL_TRANSITION: 409,
  HASH_MISMATCH: 422,
  PRICE_MISMATCH: 409,
};

const MESSAGES: Record<string, string> = {
  OUT_OF_STOCK: 'One of the items in this build just sold out.',
  CATEGORY_NOT_ALLOWED: 'That item cannot go in this slot.',
  MIN_FILL_NOT_MET: 'Add a few more items before checking out.',
  REQUIRED_SLOT_EMPTY: 'A required slot is still empty.',
  HASH_MISMATCH: 'This build could not be verified. Please rebuild it.',
  PRICE_MISMATCH: 'Prices changed while you were building. Please review.',
};

const DOMAIN_CODE = /^([A-Z_]+)(?::(.*))?$/;

export function parseDomainError(error: unknown): DomainError | null {
  const raw =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : null;
  if (!raw) return null;

  const match = DOMAIN_CODE.exec(raw);
  if (!match) return null;

  const code = match[1];
  if (!code || !(code in STATUS_BY_CODE)) return null;

  return {
    code,
    detail: match[2],
    status: STATUS_BY_CODE[code] ?? 400,
    message: MESSAGES[code] ?? 'The request could not be completed.',
  };
}

export function errorResponse(error: unknown): Response {
  const domain = parseDomainError(error);
  if (domain) {
    return Response.json(
      { error: domain.code, message: domain.message, detail: domain.detail },
      { status: domain.status },
    );
  }

  console.error('[commerce] unhandled error', error);
  return Response.json(
    { error: 'INTERNAL', message: 'Something went wrong.' },
    { status: 500 },
  );
}

export function validationResponse(issues: unknown): Response {
  return Response.json({ error: 'VALIDATION', issues }, { status: 400 });
}
