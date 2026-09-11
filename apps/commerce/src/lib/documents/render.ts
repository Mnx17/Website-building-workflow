import { formatOmr } from '../money';
import { direction } from '../i18n';
import type { CommerceDocument, InvoiceDocument, PackingSlipDocument } from './model';

/**
 * Print-ready HTML.
 *
 * HTML rather than a PDF binary for now, deliberately: a PDF with Arabic text
 * needs an embedded font with real Arabic coverage, and rendering Arabic
 * without one produces disconnected, reversed glyphs that look fine to a
 * non-reader and are unusable to the recipient. Shipping that would be worse
 * than shipping nothing. The document MODEL is renderer-independent, so a
 * React-PDF renderer slots in behind the same functions once a licensed
 * Arabic face (Tajawal / IBM Plex Sans Arabic) is vendored into the repo.
 *
 * Browser print-to-PDF handles Arabic correctly today, which covers fulfilment.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BASE_STYLES = `
  @page { size: A5; margin: 12mm; }
  body { font-family: 'Tajawal', system-ui, sans-serif; color: #16211c; margin: 0; }
  h1 { font-size: 16pt; margin: 0 0 2mm; }
  .meta { color: #667b70; font-size: 9pt; margin-bottom: 6mm; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th, td { padding: 2mm 0; text-align: start; border-block-end: 1px solid #dfd9cd; }
  td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; }
  .contents { color: #667b70; font-size: 8.5pt; padding-inline-start: 4mm; }
  .block { margin-block: 5mm; }
  .label { color: #667b70; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em; }
  .message { border: 1px solid #dfd9cd; border-radius: 3mm; padding: 4mm; font-size: 11pt; }
  .totals td { border: none; padding: 1mm 0; }
  .totals tr:last-child td { font-weight: 700; border-block-start: 1px solid #16211c; padding-block-start: 2mm; }
`;

function documentShell(params: {
  locale: 'ar' | 'en';
  title: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="${params.locale}" dir="${direction(params.locale)}">
<head><meta charset="utf-8"><title>${escapeHtml(params.title)}</title>
<style>${BASE_STYLES}</style></head>
<body>${params.body}</body></html>`;
}

function contentsRows(contents: { name: string; qty: number }[]): string {
  if (contents.length === 0) return '';
  const parts = contents.map(
    (entry) => `${escapeHtml(entry.name)}${entry.qty > 1 ? ` ×${entry.qty}` : ''}`,
  );
  return `<tr><td class="contents" colspan="2">${parts.join(' · ')}</td></tr>`;
}

/**
 * Takes a `PackingSlipDocument`, whose type carries no prices at all. There is
 * no branch here that could print one.
 */
export function renderPackingSlip(doc: PackingSlipDocument): string {
  const t =
    doc.locale === 'ar'
      ? {
          title: 'قائمة التغليف',
          order: 'رقم الطلب',
          to: 'إلى',
          phone: 'الهاتف',
          address: 'العنوان',
          items: 'الأصناف',
          qty: 'الكمية',
          message: 'رسالتك',
          weight: 'الوزن الإجمالي',
        }
      : {
          title: 'Packing slip',
          order: 'Order',
          to: 'To',
          phone: 'Phone',
          address: 'Address',
          items: 'Items',
          qty: 'Qty',
          message: 'Your message',
          weight: 'Total weight',
        };

  const rows = doc.lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.name)}</td><td class="num">${line.qty}</td></tr>` +
        contentsRows(line.contents),
    )
    .join('');

  const message = doc.giftMessage
    ? `<div class="block"><div class="label">${t.message}</div>
       <div class="message">${escapeHtml(doc.giftMessage)}</div></div>`
    : '';

  return documentShell({
    locale: doc.locale,
    title: `${t.title} ${doc.orderNumber}`,
    body: `
      <h1>${t.title}</h1>
      <div class="meta">${t.order} ${escapeHtml(doc.orderNumber)}</div>

      <div class="block">
        <div class="label">${t.to}</div>
        <div>${escapeHtml(doc.recipientName)}</div>
        <div>${t.phone}: ${escapeHtml(doc.recipientPhone)}</div>
        <div>${t.address}: ${escapeHtml(doc.deliveryLocation)}</div>
      </div>

      <table>
        <thead><tr><th>${t.items}</th><th class="num">${t.qty}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      ${message}
      <div class="meta">${t.weight}: ${doc.totalWeightGrams} g</div>`,
  });
}

export function renderInvoice(doc: InvoiceDocument): string {
  const t =
    doc.locale === 'ar'
      ? {
          title: 'فاتورة ضريبية',
          order: 'رقم الطلب',
          items: 'الأصناف',
          qty: 'الكمية',
          unit: 'سعر الوحدة',
          total: 'الإجمالي',
          subtotal: 'المجموع الفرعي',
          shipping: 'الشحن',
          vat: 'ضريبة القيمة المضافة (٥٪)',
          rounding: 'تعديل التقريب',
          grand: 'المبلغ المستحق',
        }
      : {
          title: 'Tax invoice',
          order: 'Order',
          items: 'Items',
          qty: 'Qty',
          unit: 'Unit',
          total: 'Total',
          subtotal: 'Subtotal',
          shipping: 'Shipping',
          vat: 'VAT (5%)',
          rounding: 'Rounding',
          grand: 'Amount due',
        };

  const rows = doc.lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.name)}</td>` +
        `<td class="num">${line.qty}</td>` +
        `<td class="num">${formatOmr(line.unitBaisa, doc.locale)}</td>` +
        `<td class="num">${formatOmr(line.lineTotalBaisa, doc.locale)}</td></tr>`,
    )
    .join('');

  const roundingRow =
    doc.roundingAdjustmentBaisa === 0n
      ? ''
      : `<tr><td>${t.rounding}</td><td class="num">${formatOmr(
          doc.roundingAdjustmentBaisa,
          doc.locale,
        )}</td></tr>`;

  return documentShell({
    locale: doc.locale,
    title: `${t.title} ${doc.orderNumber}`,
    body: `
      <h1>${t.title}</h1>
      <div class="meta">${t.order} ${escapeHtml(doc.orderNumber)}</div>

      <table>
        <thead><tr>
          <th>${t.items}</th><th class="num">${t.qty}</th>
          <th class="num">${t.unit}</th><th class="num">${t.total}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>

      <table class="totals block">
        <tr><td>${t.subtotal}</td><td class="num">${formatOmr(doc.subtotalBaisa, doc.locale)}</td></tr>
        <tr><td>${t.shipping}</td><td class="num">${formatOmr(doc.shippingBaisa, doc.locale)}</td></tr>
        <tr><td>${t.vat}</td><td class="num">${formatOmr(doc.vatBaisa, doc.locale)}</td></tr>
        ${roundingRow}
        <tr><td>${t.grand}</td><td class="num">${formatOmr(doc.totalBaisa, doc.locale)}</td></tr>
      </table>`,
  });
}

export function renderDocument(doc: CommerceDocument): string {
  return doc.kind === 'packing_slip' ? renderPackingSlip(doc) : renderInvoice(doc);
}
