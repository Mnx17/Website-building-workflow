import { createHmac, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';

/**
 * Staff authentication.
 *
 * Supabase issues HS256 JWTs signed with the project's JWT secret, so
 * verification is a local HMAC check — no network call on every admin request,
 * and no dependency on the Supabase client in a Route Handler.
 *
 * The JWT establishes *who* the caller is. It never establishes what they may
 * do: the role comes from `staff_users`, read server-side. A token cannot
 * claim `role: admin` and be believed, because the claim is ignored.
 */

export type StaffRole = 'admin' | 'editor' | 'fulfillment';

export type Session = {
  userId: string;
  email: string | undefined;
  role: StaffRole;
};

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type JwtPayload = {
  sub?: string;
  email?: string;
  exp?: number;
  iat?: number;
};

function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

/**
 * Verifies an HS256 JWT and returns its payload.
 *
 * Deliberately strict about the algorithm: accepting the token's own `alg`
 * header is the classic JWT vulnerability — a forged `alg: none` or an
 * HS256-signed-with-the-public-key token walks straight through.
 */
export function verifySupabaseJwt(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('MALFORMED_TOKEN', 401);

  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerSegment).toString('utf8')) as typeof header;
  } catch {
    throw new AuthError('MALFORMED_TOKEN', 401);
  }
  if (header.alg !== 'HS256') throw new AuthError('UNSUPPORTED_ALG', 401);

  const expected = createHmac('sha256', secret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  const provided = base64UrlDecode(signatureSegment);

  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
    throw new AuthError('BAD_SIGNATURE', 401);
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadSegment).toString('utf8')) as JwtPayload;
  } catch {
    throw new AuthError('MALFORMED_TOKEN', 401);
  }

  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new AuthError('TOKEN_EXPIRED', 401);
  }
  if (!payload.sub) throw new AuthError('TOKEN_MISSING_SUBJECT', 401);

  return payload;
}

function bearerToken(request: Request): string {
  // Header first (the admin fetch client), then the Supabase cookie.
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  const cookie = request.headers.get('cookie') ?? '';
  const match = /(?:^|;\s*)sb-access-token=([^;]+)/.exec(cookie);
  if (match?.[1]) return decodeURIComponent(match[1]);

  throw new AuthError('NO_CREDENTIALS', 401);
}

/**
 * Resolves the caller's staff session, or throws.
 *
 * Fails closed in every direction: no secret configured, no token, a bad
 * signature, an expired token, or a valid user who is simply not staff.
 */
export async function requireSession(
  sql: postgres.ISql,
  request: Request,
  env = process.env,
): Promise<Session> {
  const secret = env['SUPABASE_JWT_SECRET'];
  if (!secret) {
    // Not "allow everything in development" — an unconfigured deploy must not
    // become an open admin panel.
    throw new AuthError('AUTH_NOT_CONFIGURED', 503);
  }

  const payload = verifySupabaseJwt(bearerToken(request), secret);

  const [staff] = await sql<{ role: StaffRole }[]>`
    select role from staff_users where user_id = ${payload.sub!}
  `;
  if (!staff) throw new AuthError('NOT_STAFF', 403);

  return { userId: payload.sub!, email: payload.email, role: staff.role };
}

export async function requireRole(
  sql: postgres.ISql,
  request: Request,
  allowed: readonly StaffRole[],
  env = process.env,
): Promise<Session> {
  const session = await requireSession(sql, request, env);
  if (!allowed.includes(session.role)) {
    throw new AuthError('INSUFFICIENT_ROLE', 403);
  }
  return session;
}

/**
 * Lets a buyer fetch their own invoice without being staff.
 * Returns null when the caller is neither staff nor the order's owner.
 */
export async function sessionForOrder(
  sql: postgres.ISql,
  request: Request,
  orderId: string,
  env = process.env,
): Promise<{ kind: 'staff'; session: Session } | { kind: 'buyer'; userId: string } | null> {
  let session: Session;
  try {
    session = await requireSession(sql, request, env);
    return { kind: 'staff', session };
  } catch (error) {
    if (error instanceof AuthError && error.status === 403) {
      // Authenticated, just not staff — they may still own the order.
      const secret = env['SUPABASE_JWT_SECRET'];
      if (!secret) return null;
      const payload = verifySupabaseJwt(bearerToken(request), secret);
      const [owned] = await sql<{ id: string }[]>`
        select id from orders where id = ${orderId} and user_id = ${payload.sub!}
      `;
      return owned ? { kind: 'buyer', userId: payload.sub! } : null;
    }
    return null;
  }
}

export function authErrorResponse(error: unknown): Response | null {
  if (!(error instanceof AuthError)) return null;
  return Response.json({ error: error.message }, { status: error.status });
}
