import { notFound } from 'next/navigation';
import { getSql } from '@/lib/db';
import { loadCompositeProduct, loadMaterials } from '@/lib/repositories/catalog';
import { ConfiguratorClient } from '@/components/configurator/ConfiguratorClient';
import { isLocale } from '@/lib/i18n';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // availability must not be cached

export default async function ConfigurePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();

  const sql = getSql();
  const [product, materials] = await Promise.all([
    loadCompositeProduct(sql, slug),
    loadMaterials(sql),
  ]);

  if (!product) notFound();

  return <ConfiguratorClient product={product} materials={materials} locale={locale} />;
}
