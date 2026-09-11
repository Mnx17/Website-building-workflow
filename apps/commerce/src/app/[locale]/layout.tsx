import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { direction, isLocale, LOCALES } from '@/lib/i18n';
import { getSql } from '@/lib/db';
import { loadActiveTheme, themeStyleSheet } from '@/lib/theme';
import '../globals.css';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

// The active theme is tenant configuration that staff can change without a
// deploy, so this cannot be baked in at build time.
export const dynamic = 'force-dynamic';

/**
 * Root layout.
 *
 * `dir` is set here, from the route segment, rather than toggled by client
 * script: direction is a document-level property, and setting it after
 * hydration produces a visible flip on first paint. Everything downstream uses
 * CSS logical properties, so no component needs to know which direction it is
 * in.
 *
 * The theme is emitted as custom properties in the same pass — no client JS,
 * no flash of unthemed content.
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const theme = await loadActiveTheme(getSql());

  return (
    <html lang={locale} dir={direction(locale)}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeStyleSheet(theme) }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

export const metadata = {
  title: 'Sweets Commerce',
};
