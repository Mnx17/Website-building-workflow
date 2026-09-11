import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { direction, isLocale, LOCALES } from '@/lib/i18n';
import '../globals.css';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

/**
 * Root layout.
 *
 * `dir` is set here, from the route segment, rather than toggled by client
 * script: direction is a document-level property, and setting it after
 * hydration produces a visible flip on first paint. Everything downstream uses
 * CSS logical properties, so no component needs to know which direction it is
 * in.
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

  return (
    <html lang={locale} dir={direction(locale)}>
      <body>{children}</body>
    </html>
  );
}

export const metadata = {
  title: 'Sweets Commerce',
};
