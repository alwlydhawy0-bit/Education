import { useEffect, useState } from 'react';
import { apiRequest } from '../../shared/api/client.ts';
import { useLocale } from '../../app/LocaleProvider.tsx';

type Status = 'checking' | 'ok' | 'unavailable';

/**
 * The single feature in the foundation, and it exists only as an architectural
 * proof: it shows a feature module consuming the shared API client and the
 * locale context without reaching into any other feature.
 *
 * It is not product UI. Real features arrive in later tasks.
 */
export function HealthIndicator(): JSX.Element {
  const { t } = useLocale();
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<{ status: string }>('/health', { signal: controller.signal })
      .then(() => setStatus('ok'))
      .catch(() => setStatus('unavailable'));
    return () => controller.abort();
  }, []);

  const message =
    status === 'checking'
      ? t('health.checking')
      : status === 'ok'
        ? t('health.ok')
        : t('health.unavailable');

  return <p data-testid="health-status">{message}</p>;
}
