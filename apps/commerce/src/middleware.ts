import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE, LOCALES } from '@/lib/i18n';

/**
 * Sends `/` to a locale segment. Prefers Arabic when the browser asks for it,
 * since the storefront serves Oman first; everything else falls back to
 * English.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const hasLocale = LOCALES.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
  if (hasLocale) return NextResponse.next();

  const accepted = request.headers.get('accept-language') ?? '';
  const locale = accepted.toLowerCase().includes('ar') ? 'ar' : DEFAULT_LOCALE;

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ['/((?!api|_next|.*\\..*).*)'],
};
