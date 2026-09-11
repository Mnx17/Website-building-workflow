import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '@/lib/db';
import { isLocale, translator } from '@/lib/i18n';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Order confirmation.
 *
 * Reads the order's real status rather than trusting the redirect: a customer
 * can navigate here by hand, and the gateway's return hop is a hint, not proof
 * of payment. Only the webhook moves an order to `paid`.
 */
export default async function CheckoutSuccess({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ order?: string }>;
}) {
  const { locale } = await params;
  const { order } = await searchParams;
  if (!isLocale(locale)) notFound();

  const t = translator(locale);

  const [row] = order
    ? await getSql()<{ order_number: string; status: string }[]>`
        select order_number, status from orders where id = ${order}
      `
    : [];

  if (!row) notFound();

  const paid = row.status !== 'pending';

  return (
    <main className="page">
      <h1>{t('checkout.successTitle')}</h1>
      <p data-testid="order-state" data-status={row.status}>
        {paid
          ? t('checkout.successBody', { order: row.order_number })
          : t('checkout.pendingBody', { order: row.order_number })}
      </p>
      <Link href={`/${locale}`}>&larr; {t('cart.title')}</Link>
    </main>
  );
}
