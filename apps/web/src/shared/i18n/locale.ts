/**
 * Localization core.
 *
 * Arabic is the DEFAULT, not a translation of an English original. That shows
 * up in three places: `DEFAULT_LOCALE` is 'ar', the served HTML ships with
 * `dir="rtl"`, and the dictionary type is keyed off the Arabic catalogue so a
 * missing Arabic string is a compile error.
 *
 * Direction is derived from the locale rather than stored alongside it, so the
 * two cannot drift apart.
 */
export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ar';

export type Direction = 'rtl' | 'ltr';

const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar']);

export function directionFor(locale: Locale): Direction {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Picks a locale from an Accept-Language-style preference list, falling back to
 * Arabic. Region subtags are tolerated ('ar-SA' matches 'ar').
 */
export function negotiateLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    const base = preference.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/**
 * Applies the locale to the document element.
 *
 * Setting `dir` on <html> (rather than on a wrapper div) is what makes the
 * browser's own bidirectional algorithm, scrollbar placement, and logical CSS
 * properties behave correctly for the whole page.
 */
export function applyDocumentLocale(doc: Document, locale: Locale): void {
  doc.documentElement.lang = locale;
  doc.documentElement.dir = directionFor(locale);
}
