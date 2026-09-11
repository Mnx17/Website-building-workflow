import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthError, verifySupabaseJwt } from '@/lib/auth';
import { FALLBACK_THEME, themeStyleSheet } from '@/lib/theme';

const SECRET = 'super-secret-jwt-key';
const NOW = 1_700_000_000;

function b64url(input: object | string): string {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return Buffer.from(raw).toString('base64url');
}

export function mintJwt(params: {
  sub?: string;
  email?: string;
  exp?: number;
  secret?: string;
  alg?: string;
  tamperPayload?: boolean;
}): string {
  const header = b64url({ alg: params.alg ?? 'HS256', typ: 'JWT' });
  const payload = b64url({
    sub: params.sub ?? '00000000-0000-4000-8000-00000000000a',
    email: params.email ?? 'staff@example.com',
    exp: params.exp ?? NOW + 3600,
  });
  const signature = createHmac('sha256', params.secret ?? SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');

  const finalPayload = params.tamperPayload
    ? b64url({ sub: 'attacker', exp: NOW + 3600 })
    : payload;

  return `${header}.${finalPayload}.${signature}`;
}

describe('verifySupabaseJwt', () => {
  it('accepts a well-formed token', () => {
    const payload = verifySupabaseJwt(mintJwt({}), SECRET, NOW);
    expect(payload.sub).toBe('00000000-0000-4000-8000-00000000000a');
    expect(payload.email).toBe('staff@example.com');
  });

  it('rejects a token signed with the wrong secret', () => {
    expect(() => verifySupabaseJwt(mintJwt({ secret: 'wrong' }), SECRET, NOW)).toThrow(
      /BAD_SIGNATURE/,
    );
  });

  it('rejects a tampered payload', () => {
    expect(() => verifySupabaseJwt(mintJwt({ tamperPayload: true }), SECRET, NOW)).toThrow(
      /BAD_SIGNATURE/,
    );
  });

  it('rejects alg:none — the classic JWT bypass', () => {
    const header = b64url({ alg: 'none', typ: 'JWT' });
    const payload = b64url({ sub: 'attacker', exp: NOW + 3600 });
    expect(() => verifySupabaseJwt(`${header}.${payload}.`, SECRET, NOW)).toThrow(
      /UNSUPPORTED_ALG/,
    );
  });

  it('rejects an algorithm swap even when the signature is valid for it', () => {
    // A token honestly signed HS512 must still be refused: we accept exactly
    // one algorithm rather than trusting the token's own header.
    expect(() => verifySupabaseJwt(mintJwt({ alg: 'HS512' }), SECRET, NOW)).toThrow(
      /UNSUPPORTED_ALG/,
    );
  });

  it('rejects an expired token', () => {
    expect(() => verifySupabaseJwt(mintJwt({ exp: NOW - 1 }), SECRET, NOW)).toThrow(
      /TOKEN_EXPIRED/,
    );
  });

  it('rejects a token with no expiry at all', () => {
    const header = b64url({ alg: 'HS256', typ: 'JWT' });
    const payload = b64url({ sub: 'someone' });
    const signature = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(() => verifySupabaseJwt(`${header}.${payload}.${signature}`, SECRET, NOW)).toThrow(
      /TOKEN_EXPIRED/,
    );
  });

  it('rejects a token with no subject', () => {
    const header = b64url({ alg: 'HS256', typ: 'JWT' });
    const payload = b64url({ exp: NOW + 3600 });
    const signature = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(() => verifySupabaseJwt(`${header}.${payload}.${signature}`, SECRET, NOW)).toThrow(
      /TOKEN_MISSING_SUBJECT/,
    );
  });

  it.each(['', 'garbage', 'a.b', 'a.b.c.d'])('rejects malformed token %j', (token) => {
    expect(() => verifySupabaseJwt(token, SECRET, NOW)).toThrow(AuthError);
  });

  it('does not throw a non-AuthError on hostile input', () => {
    for (const token of ['.'.repeat(50), '..', 'x'.repeat(10_000)]) {
      expect(() => verifySupabaseJwt(token, SECRET, NOW)).toThrow(AuthError);
    }
  });
});

describe('themeStyleSheet', () => {
  it('emits the theme as custom properties', () => {
    const css = themeStyleSheet({
      ...FALLBACK_THEME,
      primary_color: '#AABBCC',
      secondary_color: '#112233',
      font_family: 'Cairo',
    });
    expect(css).toContain('--brand-primary:#AABBCC');
    expect(css).toContain('--brand-secondary:#112233');
    expect(css).toContain("--brand-font:'Cairo'");
  });

  it('refuses a colour that is not a hex triplet, even from the database', () => {
    // This string goes into a <style> tag. A CHECK constraint guards the
    // column, but a value that arrived another way must not become injection.
    const css = themeStyleSheet({
      ...FALLBACK_THEME,
      primary_color: 'red;} body{display:none}',
    });
    expect(css).not.toContain('display:none');
    expect(css).toContain(FALLBACK_THEME.primary_color);
  });

  it('strips anything unexpected from the font name', () => {
    const css = themeStyleSheet({
      ...FALLBACK_THEME,
      font_family: "Tajawal'; } body { content: 'x",
    });
    expect(css).not.toContain('body {');
    expect(css).toMatch(/--brand-font:'[A-Za-z0-9 -]+';/);
  });
});
