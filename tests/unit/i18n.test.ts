import { describe, expect, it } from 'vitest';
import {
  applyDocumentLocale,
  DEFAULT_LOCALE,
  directionFor,
  isLocale,
  LOCALES,
  negotiateLocale,
} from '../../apps/web/src/shared/i18n/locale.js';
import { translate, type MessageKey } from '../../apps/web/src/shared/i18n/messages.js';

/**
 * Arabic-first behaviour and RTL correctness.
 *
 * These are pure functions precisely so that the direction rules can be tested
 * without a browser — direction bugs are otherwise only caught by eye, late.
 */
describe('locale', () => {
  it('defaults to Arabic', () => {
    expect(DEFAULT_LOCALE).toBe('ar');
  });

  it('maps Arabic to RTL and English to LTR', () => {
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('en')).toBe('ltr');
  });

  it('negotiates a region subtag down to its base locale', () => {
    expect(negotiateLocale(['ar-SA'])).toBe('ar');
    expect(negotiateLocale(['en-GB'])).toBe('en');
  });

  it('falls back to Arabic for an unsupported language', () => {
    expect(negotiateLocale(['fr-FR', 'de'])).toBe('ar');
    expect(negotiateLocale([])).toBe('ar');
  });

  it('prefers the first supported preference in order', () => {
    expect(negotiateLocale(['fr', 'en', 'ar'])).toBe('en');
  });

  it('rejects unknown locale values', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('ru')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it('sets lang and dir on the document element', () => {
    const documentElement = { lang: '', dir: '' };
    const fakeDoc = { documentElement } as unknown as Document;

    applyDocumentLocale(fakeDoc, 'ar');
    expect(documentElement).toEqual({ lang: 'ar', dir: 'rtl' });

    applyDocumentLocale(fakeDoc, 'en');
    expect(documentElement).toEqual({ lang: 'en', dir: 'ltr' });
  });
});

describe('messages', () => {
  const keys: MessageKey[] = [
    'app.title',
    'app.tagline',
    'health.checking',
    'health.ok',
    'health.unavailable',
    'language.switch',
  ];

  it.each(LOCALES)('has a non-empty string for every key in "%s"', (locale) => {
    for (const key of keys) {
      expect(translate(locale, key).length).toBeGreaterThan(0);
    }
  });

  it('returns genuine Arabic (not an English fallback) for the Arabic catalogue', () => {
    // A catalogue silently falling back to English would be invisible in the UI
    // review of an English-speaking developer.
    expect(translate('ar', 'app.title')).toMatch(/[؀-ۿ]/);
  });

  it('never returns the raw key to a user', () => {
    expect(translate('en', 'app.title')).not.toBe('app.title');
  });
});
