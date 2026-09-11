import type { ReactNode } from 'react';

/**
 * Placeholder root layout. P2 replaces this with the `[locale]` segment that
 * sets `dir="rtl"` for Arabic; direction is a layout-level concern from the
 * first commit rather than a retrofit.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}

export const metadata = {
  title: 'Sweets Commerce',
};
