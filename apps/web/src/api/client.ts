import { ApiRequestError, NETWORK_PROBLEM, normalizeProblem } from './problem';

export const LOGIN_PATH = '/auth/login';

export interface ClientDeps {
  fetchFn: typeof fetch;
  getToken: () => string | null;
  /** Вызывается при 401 на запросе с токеном, который всё ещё текущий (RULES §7-1). */
  onUnauthorized: () => void;
  baseUrl?: string;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
}

export function createApiClient(deps: ClientDeps): ApiClient {
  const base = deps.baseUrl ?? '/api';

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const isLogin = path === LOGIN_PATH;
    const sentToken = isLogin ? null : deps.getToken();
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (sentToken) headers.Authorization = `Bearer ${sentToken}`;

    let res: Response;
    try {
      res = await deps.fetchFn(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiRequestError(NETWORK_PROBLEM);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // Неверный пароль при входе тоже 401, но это не истёкшая сессия (RULES §7-1).
      // Реагируем один раз: если токен уже сброшен или заменён, поздний 401 игнорируется.
      if (res.status === 401 && sentToken !== null && sentToken === deps.getToken()) {
        deps.onUnauthorized();
      }
      throw new ApiRequestError(normalizeProblem(res.status, text));
    }
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    patch: (path, body) => request('PATCH', path, body),
  };
}
