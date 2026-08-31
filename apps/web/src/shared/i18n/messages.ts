import type { Locale } from './locale.ts';

/**
 * Message catalogues.
 *
 * The Arabic catalogue is the source of truth: `MessageKey` is derived from it,
 * so adding an Arabic string without an English one is a type error (and vice
 * versa). A real translation pipeline replaces this later; the important part
 * for the foundation is that lookups are typed and that no component contains a
 * hard-coded user-visible string.
 */
const ar = {
  'app.title': 'منصة التعلم',
  'app.tagline': 'تعلّم، استقصِ، جرّب، وطبّق',
  'health.checking': 'جارٍ التحقق من حالة الخدمة…',
  'health.ok': 'الخدمة تعمل',
  'health.unavailable': 'تعذّر الوصول إلى الخدمة',
  'language.switch': 'English',
} as const;

export type MessageKey = keyof typeof ar;

const en: Record<MessageKey, string> = {
  'app.title': 'Learning Platform',
  'app.tagline': 'Learn, investigate, experiment, and apply',
  'health.checking': 'Checking service status…',
  'health.ok': 'Service is running',
  'health.unavailable': 'Service is unreachable',
  'language.switch': 'العربية',
};

const CATALOGUES: Record<Locale, Record<MessageKey, string>> = { ar, en };

export function translate(locale: Locale, key: MessageKey): string {
  // Falls back to Arabic rather than to the key itself: showing a raw
  // identifier to a student is worse than showing the default language.
  return CATALOGUES[locale][key] ?? CATALOGUES.ar[key];
}
