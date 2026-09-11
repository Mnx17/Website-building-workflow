import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shared webhook signature checking.
 *
 * Three things matter here and each has bitten real integrations:
 *   1. Hash the RAW body bytes. Re-serialising parsed JSON changes key order
 *      and whitespace, and the signature stops matching.
 *   2. Compare with `timingSafeEqual`, not `===`.
 *   3. Reject stale timestamps, so a captured payload cannot be replayed
 *      indefinitely even if the dedupe table is ever cleared.
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'bad_signature' | 'stale' | 'missing_timestamp' };

export function verifyHmacSignature(params: {
  rawBody: string;
  signature: string | null;
  secret: string;
  /** Unix seconds, as supplied by the provider. */
  timestamp?: string | null;
  toleranceSeconds?: number;
  /** Some providers sign `${timestamp}.${body}` rather than the body alone. */
  includeTimestampInPayload?: boolean;
  nowSeconds?: number;
}): SignatureCheck {
  const {
    rawBody,
    signature,
    secret,
    timestamp = null,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    includeTimestampInPayload = false,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = params;

  if (!signature) return { ok: false, reason: 'missing_signature' };

  if (includeTimestampInPayload || timestamp !== null) {
    if (timestamp === null) return { ok: false, reason: 'missing_timestamp' };
    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return { ok: false, reason: 'missing_timestamp' };
    if (Math.abs(nowSeconds - sent) > toleranceSeconds) return { ok: false, reason: 'stale' };
  }

  const payload =
    includeTimestampInPayload && timestamp !== null ? `${timestamp}.${rawBody}` : rawBody;

  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest();

  // Accept hex or base64; providers differ, and a length mismatch must not
  // short-circuit into a `===` comparison.
  const provided = decodeSignature(signature);
  if (!provided || provided.length !== expected.length) {
    return { ok: false, reason: 'bad_signature' };
  }

  return timingSafeEqual(expected, provided) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

function decodeSignature(signature: string): Buffer | null {
  const trimmed = signature.trim().replace(/^sha256=/i, '');

  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function signPayload(body: string, secret: string, timestamp?: string): string {
  const payload = timestamp === undefined ? body : `${timestamp}.${body}`;
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}
