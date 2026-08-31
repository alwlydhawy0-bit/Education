import { useLocale } from './LocaleProvider.tsx';
import { HealthIndicator } from '../features/health/HealthIndicator.tsx';

export function App(): JSX.Element {
  const { t, locale, setLocale } = useLocale();

  return (
    <main>
      <h1>{t('app.title')}</h1>
      <p>{t('app.tagline')}</p>
      <HealthIndicator />
      <button type="button" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
        {t('language.switch')}
      </button>
    </main>
  );
}
