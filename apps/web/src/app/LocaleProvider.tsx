import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  applyDocumentLocale,
  DEFAULT_LOCALE,
  directionFor,
  negotiateLocale,
  type Direction,
  type Locale,
} from '../shared/i18n/locale.js';
import { translate, type MessageKey } from '../shared/i18n/messages.js';

interface LocaleContextValue {
  readonly locale: Locale;
  readonly direction: Direction;
  readonly t: (key: MessageKey) => string;
  readonly setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Locale state for the app.
 *
 * This is UI state and lives here, in a small dedicated context — not in a
 * single global store shared with server data (section 18 of the brief). Server
 * state, when it arrives, gets its own cache; mixing the two is what produces
 * the god-store that becomes impossible to reason about.
 */
export function LocaleProvider({ children }: { children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() =>
    typeof navigator === 'undefined'
      ? DEFAULT_LOCALE
      : negotiateLocale(navigator.languages ?? [navigator.language]),
  );

  useEffect(() => {
    applyDocumentLocale(document, locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      direction: directionFor(locale),
      t: (key: MessageKey) => translate(locale, key),
      setLocale,
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used inside a LocaleProvider');
  return value;
}
