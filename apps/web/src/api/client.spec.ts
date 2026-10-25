import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { ApiRequestError, describeProblem, normalizeProblem } from './problem';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function setup(respond: () => Promise<Response>, token: string | null = 'tok') {
  let current = token;
  const onUnauthorized = vi.fn(() => {
    current = null;
  });
  const fetchFn = vi.fn(respond) as unknown as typeof fetch;
  const client = createApiClient({ fetchFn, getToken: () => current, onUnauthorized });
  return { client, fetchFn, onUnauthorized, setToken: (t: string | null) => (current = t) };
}

async function problemOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiRequestError) return e.problem;
    throw e;
  }
  throw new Error('ожидалась ошибка');
}

describe('нормализация ошибок', () => {
  // RULES §7-1
  it('ошибка каталога сохраняет код, сообщение и details', () => {
    const p = normalizeProblem(
      422,
      JSON.stringify({ statusCode: 422, code: 'X', message: 'Текст', details: { a: 1 } }),
    );
    expect(p).toEqual({ status: 422, code: 'X', message: 'Текст', details: { a: 1 } });
    expect(describeProblem(p)).toBe('Текст (X)');
  });

  // RULES §7-1
  it('500 без кода показывается без кода', () => {
    const p = normalizeProblem(500, '{"statusCode":500,"message":"Внутренняя ошибка сервера"}');
    expect(p.code).toBeUndefined();
    expect(describeProblem(p)).toBe('Внутренняя ошибка сервера');
  });

  // RULES §7-1
  it('не-JSON (страница nginx) приводится к русскому сообщению по статусу', () => {
    expect(normalizeProblem(502, '<html>Bad Gateway</html>').message).toBe('Сервер недоступен');
    expect(normalizeProblem(500, '').message).toBe('Внутренняя ошибка сервера');
    expect(normalizeProblem(418, 'teapot').message).toBe('Ошибка запроса (418)');
  });

  // RULES §7-1
  it('сетевой сбой даёт код NETWORK', async () => {
    const { client } = setup(() => Promise.reject(new TypeError('Failed to fetch')));
    const p = await problemOf(client.get('/me'));
    expect(p.code).toBe('NETWORK');
    expect(p.message).toBe('Нет связи с сервером');
  });

  // RULES §7-1
  it('403 AUTH_NOT_HIRED_YET при входе показывается как есть', async () => {
    const { client } = setup(() =>
      Promise.resolve(
        jsonResponse(403, {
          statusCode: 403,
          code: 'AUTH_NOT_HIRED_YET',
          message: 'Доступ откроется в дату выхода на работу',
        }),
      ),
    );
    const p = await problemOf(client.post('/auth/login', { login: 'a', password: 'b' }));
    expect(describeProblem(p)).toBe('Доступ откроется в дату выхода на работу (AUTH_NOT_HIRED_YET)');
  });
});

describe('401 и токен', () => {
  // RULES §7-1
  it('401 на запросе с токеном вызывает onUnauthorized один раз, даже при нескольких ответах', async () => {
    const { client, onUnauthorized } = setup(() =>
      Promise.resolve(jsonResponse(401, { statusCode: 401, code: 'AUTH_REQUIRED', message: 'Требуется вход' })),
    );
    await Promise.allSettled([client.get('/me'), client.get('/me'), client.get('/me')]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  // RULES §7-1
  it('401 при неверном пароле не считается истёкшей сессией', async () => {
    const { client, onUnauthorized } = setup(
      () =>
        Promise.resolve(
          jsonResponse(401, {
            statusCode: 401,
            code: 'AUTH_INVALID_CREDENTIALS',
            message: 'Неверный логин или пароль',
          }),
        ),
      null,
    );
    const p = await problemOf(client.post('/auth/login', { login: 'a', password: 'b' }));
    expect(p.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  // RULES §7-1
  it('вход не отправляет старый токен и 401 входа не сбрасывает действующую сессию', async () => {
    const { client, fetchFn, onUnauthorized } = setup(() =>
      Promise.resolve(jsonResponse(401, { statusCode: 401, code: 'AUTH_INVALID_CREDENTIALS', message: 'x' })),
    );
    await problemOf(client.post('/auth/login', { login: 'a', password: 'b' }));
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  // RULES §7-1
  it('поздний 401 на запрос со старым токеном не сбрасывает новую сессию', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client, onUnauthorized, setToken } = setup(async () => {
      await gate;
      return jsonResponse(401, { statusCode: 401, code: 'AUTH_REQUIRED', message: 'Требуется вход' });
    });
    const pending = problemOf(client.get('/me'));
    setToken('new-token');
    release();
    await pending;
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  // RULES §7-1
  it('токен уходит только в заголовке Authorization', async () => {
    const { client, fetchFn } = setup(() => Promise.resolve(jsonResponse(200, { ok: true })));
    await client.get('/me');
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/me');
    expect(url).not.toContain('tok');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});
