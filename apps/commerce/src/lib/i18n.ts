import type { Locale } from './configurator/types';

export const LOCALES = ['en', 'ar'] as const;
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function direction(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

const MESSAGES = {
  en: {
    'configurator.tray': 'Choose your items',
    'configurator.dragHint': 'Drag an item onto a slot, or tap an item then tap a slot.',
    'configurator.soldOut': 'Sold out',
    'configurator.slotsFilled': '{filled} of {total} slots filled',
    'configurator.needMore': 'Fill at least {required} slots to continue',
    'configurator.requiredEmpty': 'A required slot is still empty',
    'configurator.categoryNotAllowed': 'That item cannot go in this slot',
    'configurator.reset': 'Start over',
    'configurator.addToCart': 'Add to cart',
    'configurator.adding': 'Adding…',
    'configurator.added': 'Added to cart',
    'configurator.estimated': 'Estimated',
    'configurator.confirming': 'Confirming price…',
    'configurator.confirmed': 'Price confirmed',
    'configurator.priceError': 'Could not confirm price. Check your connection.',
    'configurator.repriced': 'Prices changed while you were building — updated.',
    'configurator.weight': '{grams} g',
  },
  ar: {
    'configurator.tray': 'اختر الأصناف',
    'configurator.dragHint': 'اسحب صنفاً إلى الخانة، أو اضغط على الصنف ثم على الخانة.',
    'configurator.soldOut': 'نفد المخزون',
    'configurator.slotsFilled': 'تم ملء {filled} من {total} خانات',
    'configurator.needMore': 'املأ {required} خانات على الأقل للمتابعة',
    'configurator.requiredEmpty': 'هناك خانة مطلوبة ما زالت فارغة',
    'configurator.categoryNotAllowed': 'لا يمكن وضع هذا الصنف في هذه الخانة',
    'configurator.reset': 'ابدأ من جديد',
    'configurator.addToCart': 'أضف إلى السلة',
    'configurator.adding': 'جارٍ الإضافة…',
    'configurator.added': 'تمت الإضافة إلى السلة',
    'configurator.estimated': 'السعر التقديري',
    'configurator.confirming': 'جارٍ تأكيد السعر…',
    'configurator.confirmed': 'تم تأكيد السعر',
    'configurator.priceError': 'تعذر تأكيد السعر. تحقق من اتصالك.',
    'configurator.repriced': 'تغيرت الأسعار أثناء التصميم — تم التحديث.',
    'configurator.weight': '{grams} غرام',
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type MessageKey = keyof (typeof MESSAGES)['en'];

/**
 * Minimal ICU-style interpolation. Arabic plural rules have six forms, so any
 * string that needs real pluralisation must get `Intl.PluralRules` rather than
 * a naive `{n} items` template — none of the current strings do.
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  const template: string = MESSAGES[locale][key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

export function translator(locale: Locale) {
  return (key: MessageKey, values?: Record<string, string | number>) =>
    translate(locale, key, values);
}
