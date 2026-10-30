import { test, expect } from './fixtures';
import { apiToken, decideViaApi, submitViaApi } from './helpers';

// Поток GET /events через nginx в Docker (RULES §10-2; architecture §9): кадры не буферизуются.
// Клиент - Node fetch, как fetch-stream в браузере: токен только в заголовке.
// При буферизации nginx задерживает и заголовки ответа, поэтому срок стоит и на них.
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080';
const LIMIT_MS = 2_000;

/** Ждёт обещание не дольше LIMIT_MS. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} не пришло за 2 с: nginx буферизует поток?`)), LIMIT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test.describe('SSE через nginx', () => {
  // RULES §10-2: событие доходит до клиента сразу, а не после заполнения буфера nginx
  test('text/event-stream, событие меньше чем через 2 с после действия', async ({ request }) => {
    const token = await apiToken(request, 'james');
    const id = await submitViaApi(request, 'james', {
      startDate: '2026-11-09',
      endDate: '2026-11-13',
      backstopper: 'Sophie Bennett',
    });
    const abort = new AbortController();
    const opening = fetch(`${BASE_URL}/api/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    // обрыв потока в finally не должен давать необработанный отказ
    opening.catch(() => {});
    try {
      const res = await within(opening, 'Начало ответа');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const arrived = (async () => {
        while (!text.includes('event: vacation.approved')) {
          const { done, value } = await reader.read();
          if (done) throw new Error('поток закрыт до события');
          text += decoder.decode(value, { stream: true });
        }
      })();
      arrived.catch(() => {});

      await decideViaApi(request, 'daniel', id, 'approve');
      await within(arrived, 'Событие');
      expect(text).toContain(`"vacationId":${id}`);
    } finally {
      abort.abort();
    }
  });
});
