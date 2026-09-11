import type postgres from 'postgres';

/**
 * Fixed-window rate limiting, counted in Postgres.
 *
 * An in-memory limiter is worse than none on serverless: each instance keeps
 * its own counter, so the effective limit is the configured limit times the
 * instance count, and it silently resets on every cold start.
 *
 * Fixed windows allow a burst of up to 2× the limit across a window boundary.
 * That is an accepted trade for the endpoints here — the goal is to stop a
 * script hammering the price endpoint or minting unlimited carts, not to
 * enforce a precise rate.
 */

export type RateLimitResult = {
  allowed: boolean;
  hits: number;
  limit: number;
  retryAfterSeconds: number;
};

export type RateLimitRule = {
  limit: number;
  windowSeconds: number;
};

export const RATE_LIMITS = {
  /** Debounced at 400ms client-side, so a real user makes well under this. */
  price: { limit: 120, windowSeconds: 60 },
  /** Cart creation is an unauthenticated insert; keep it tight. */
  cartCreate: { limit: 10, windowSeconds: 60 },
  cartMutate: { limit: 120, windowSeconds: 60 },
  /** Money endpoint. A legitimate shopper checks out once. */
  checkout: { limit: 10, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Best-effort client identifier, or null when the client cannot be identified.
 *
 * `x-forwarded-for` is spoofable in general, but behind a trusted proxy
 * (Vercel) the leftmost entry is the real client. This is a throttle, not an
 * access control — nothing security-critical depends on it being unforgeable.
 *
 * Returning null rather than a constant like `'unknown'` matters: a shared
 * fallback bucket puts EVERY unidentified caller in one counter, so on a
 * deployment with no proxy header the first N customers per window succeed and
 * every other customer is refused. A throttle that takes the site down is
 * worse than no throttle.
 */
export function clientKey(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip');
}

export async function checkRateLimit(
  sql: postgres.ISql,
  name: keyof typeof RATE_LIMITS,
  identifier: string,
): Promise<RateLimitResult> {
  const rule: RateLimitRule = RATE_LIMITS[name];
  const bucket = `${name}:${identifier}`;

  const [row] = await sql<{ bump_rate_limit: number }[]>`
    select bump_rate_limit(${bucket}, ${rule.windowSeconds})
  `;
  const hits = row?.bump_rate_limit ?? 0;

  return {
    allowed: hits <= rule.limit,
    hits,
    limit: rule.limit,
    retryAfterSeconds: rule.windowSeconds,
  };
}

export function rateLimitResponse(result: RateLimitResult): Response {
  return Response.json(
    { error: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
    {
      status: 429,
      headers: {
        'retry-after': String(result.retryAfterSeconds),
        'x-ratelimit-limit': String(result.limit),
        'x-ratelimit-remaining': String(Math.max(result.limit - result.hits, 0)),
      },
    },
  );
}

/**
 * Guard helper: returns a 429 Response when over the limit, else null.
 *
 * Pass `identifier` wherever something better than an IP exists — a cart id,
 * for instance. It is both more accurate (one shopper behind CGNAT is not a
 * hundred) and immune to the no-proxy-header problem above.
 *
 * Fails OPEN twice over:
 *   - No identifiable client → no limit, with a warning. Better than punishing
 *     everyone through a shared bucket.
 *   - Database error → no limit. A limiter outage must not take checkout down
 *     with it; losing throttling for a few minutes is cheaper than losing sales.
 */
export async function enforceRateLimit(
  sql: postgres.ISql,
  name: keyof typeof RATE_LIMITS,
  request: Request,
  identifier?: string | null,
): Promise<Response | null> {
  const key = identifier ?? clientKey(request);
  if (!key) {
    console.warn(`[rate-limit] no client identifier for ${name}; not limiting`);
    return null;
  }

  try {
    const result = await checkRateLimit(sql, name, key);
    return result.allowed ? null : rateLimitResponse(result);
  } catch (error) {
    console.error('[rate-limit] check failed, allowing request', error);
    return null;
  }
}
