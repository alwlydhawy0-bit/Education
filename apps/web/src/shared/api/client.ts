import { errorResponseSchema } from '@edu/contracts';
import { clientConfig } from '../config/index.ts';

/**
 * The single place the web app talks to the API.
 *
 * Everything goes through here so that credentials handling, the CSRF-relevant
 * headers, and error decoding exist once rather than in every feature. A feature
 * that called `fetch` directly would be able to forget any of the three.
 *
 * Note what is NOT here: no token storage, no Authorization header. The session
 * is an HttpOnly cookie the browser attaches automatically, which is precisely
 * why JavaScript in this bundle cannot read or exfiltrate it.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string | null;

  constructor(status: number, code: string, message: string, correlationId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const hasBody = options.body !== undefined;

  const response = await fetch(`/api/${clientConfig.apiVersion}${path}`, {
    method,
    // Sends the session cookie. Combined with SameSite=Strict on the server
    // side, and the server's Origin allow-list, this is the CSRF posture.
    credentials: 'same-origin',
    headers: hasBody ? { 'content-type': 'application/json' } : {},
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.correlationId,
      );
    }
    throw new ApiError(response.status, 'INTERNAL', 'Unexpected error', null);
  }

  return payload as T;
}
