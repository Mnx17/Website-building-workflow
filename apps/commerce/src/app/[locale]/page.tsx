import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '@/lib/db';
import { isLocale } from '@/lib/i18n';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const composites = await getSql()<
    { slug: string; name_en: string; name_ar: string; kind: string }[]
  >`
    select slug, name_en, name_ar, kind
      from composite_products
     where is_active
     order by kind
  `;

  return (
    <main className="home">
      <h1>{locale === 'ar' ? 'صمم هديتك' : 'Build your gift'}</h1>
      <ul className="home__list">
        {composites.map((composite) => (
          <li key={composite.slug}>
            <Link href={`/${locale}/configure/${composite.slug}`}>
              {locale === 'ar' ? composite.name_ar : composite.name_en}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
