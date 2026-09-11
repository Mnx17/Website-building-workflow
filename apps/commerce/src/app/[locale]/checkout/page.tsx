import { notFound } from 'next/navigation';
import { getSql } from '@/lib/db';
import { isLocale } from '@/lib/i18n';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  // Governorates come from the shipping zones themselves, so the form can only
  // offer somewhere the calculator can actually quote.
  const rows = await getSql()<{ governorate: string }[]>`
    select distinct unnest(governorates) as governorate
      from shipping_zones
     order by governorate
  `;

  return (
    <main className="page">
      <CheckoutForm locale={locale} governorates={rows.map((row) => row.governorate)} />
    </main>
  );
}
