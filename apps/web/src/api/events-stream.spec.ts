import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameParser, openEventStream, RETRY_DELAYS_MS, type StreamHandlers } from './events-stream';

/** Ответ 200 с телом-потоком, в который тест дописывает кадры. */
function streamResponse() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const enc = new TextEncoder();
  return {
    res: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (s: string) => ctrl.enqueue(enc.encode(s)),
    end: () => ctrl.close(),
    fail: () => ctrl.error(new Error('обрыв')),
  };
}

function setup(responses: (() => Promise<Response>)[], token: string | null = 'tok') {
  let current = token;
  const onUnauthorized = vi.fn(() => {
    current = null;
  });
  const fetchFn = vi.fn((...args: Parameters<typeof fetch>) => {
    void args;
    const next = responses.shift();
    return next ? next() : Promise.reject(new TypeError('Failed to fetch'));
  });
  const handlers = {
    onEvent: vi.fn<StreamHandlers['onEvent']>(),
    onOpen: vi.fn<StreamHandlers['onOpen']>(),
    onDrop: vi.fn<StreamHandlers['onDrop']>(),
  };
  const stop = openEventStream(
    { fetchFn: fetchFn as unknown as typeof fetch, getToken: () => current, onUnauthorized },
    handlers,
  );
  return { fetchFn, handlers, onUnauthorized, stop, setToken: (t: string | null) => (current = t) };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('разбор кадров SSE', () => {
  // RULES §10-2
  it('кадр, разрезанный между чанками, и два кадра в одном чанке; комментарии пропускаются', () => {
    const frames: [string, unknown][] = [];
    const parser = createFrameParser((type, data) => frames.push([type, data]));
    parser.push('event: vacation.appr');
    parser.push('oved\ndata: {"employeeId":6,"vac');
    expect(frames).toEqual([]);
    parser.push('ationId":1}\n\n: keep-alive\n\nevent: clock.changed\ndata: {"type":"clock.changed"}\n\n');
    expect(frames).toEqual([
      ['vacation.approved', { employeeId: 6, vacationId: 1 }],
      ['clock.changed', { type: 'clock.changed' }],
    ]);
  });

  // RULES §10-2
  it('CRLF и кадр без data; битый JSON не ломает разбор следующих', () => {
    const frames: [string, unknown][] = [];
    const parser = createFrameParser((type, data) => frames.push([type, data]));
    parser.push('event: a\r\n\r\nevent: b\ndata: {oops\n\nevent: c\ndata: 1\n\n');
    expect(frames).toEqual([
      ['a', undefined],
      ['c', 1],
    ]);
  });
});

describe('поток GET /events', () => {
  // RULES §7-1: токен только в заголовке, не в URL
  it('запрос /api/events с Authorization, токена в URL нет; событие доходит до обработчика', async () => {
    const s = streamResponse();
    const { fetchFn, handlers } = setup([() => Promise.resolve(s.res)]);
    await flush();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/api/events');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);

    s.push('event: vacation.cancelled\ndata: {"employeeId":6,"vacationId":2,"by":"HR_RECALL"}\n\n');
    await flush();
    expect(handlers.onEvent).toHaveBeenCalledWith('vacation.cancelled', {
      employeeId: 6,
      vacationId: 2,
      by: 'HR_RECALL',
    });
  });

  // RULES §10-2 (DECISIONS 2026-10-29 22:26): паузы 1→2→4→8→16→30 с, без лимита попыток
  it('переподключение с нарастающей паузой до 30 с', async () => {
    const { fetchFn, handlers } = setup([]);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];
    expect(RETRY_DELAYS_MS).toEqual(expected.slice(0, 6));
    for (const [i, delay] of expected.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchFn).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(i + 2);
    }
    expect(handlers.onOpen).not.toHaveBeenCalled();
    expect(handlers.onDrop).toHaveBeenCalledTimes(expected.length + 1);
  });

  // RULES §10-2: после успешного соединения пауза снова 1 с
  it('пауза сбрасывается после успешного соединения', async () => {
    const s = streamResponse();
    const { fetchFn, handlers } = setup([
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(s.res),
    ]);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);

    s.end(); // сервер закрыл поток (например, по exp токена)
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  // RULES §10-2: 502 от nginx и обрыв посреди потока - повтор
  it('502 и обрыв потока ведут к повтору', async () => {
    const s = streamResponse();
    const { fetchFn, handlers, onUnauthorized } = setup([
      () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })),
      () => Promise.resolve(s.res),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);

    s.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // 502, обрыв и третье подключение без ответа
    expect(handlers.onDrop).toHaveBeenCalledTimes(3);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  // RULES §7-1 (DECISIONS 2026-10-22 12:15): при 401 экран входа, без переподключения
  it('401 вызывает onUnauthorized один раз и не повторяет подключение', async () => {
    const { fetchFn, onUnauthorized, handlers } = setup([
      () => Promise.resolve(new Response('{"statusCode":401,"code":"AUTH_TOKEN_EXPIRED"}', { status: 401 })),
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(handlers.onDrop).not.toHaveBeenCalled();
  });

  // RULES §7-1: поздний 401 по уже заменённому токену сессию не сбрасывает
  it('401 по токену, который уже не текущий, onUnauthorized не вызывает и не повторяет', async () => {
    let resolve!: (r: Response) => void;
    const { fetchFn, onUnauthorized, setToken } = setup([() => new Promise<Response>((r) => (resolve = r))]);
    await flush();
    setToken('other');
    resolve(new Response('', { status: 401 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // RULES §7-1: выход и размонтирование прерывают поток
  it('stop() прерывает открытый поток и отменяет переподключение', async () => {
    const s = streamResponse();
    const { fetchFn, stop, handlers } = setup([() => Promise.resolve(s.res)]);
    await flush();
    const signal = fetchFn.mock.calls[0][1]?.signal as AbortSignal;
    stop();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(handlers.onDrop).not.toHaveBeenCalled();
  });

  // RULES §7-1
  it('stop() во время паузы: следующего подключения нет', async () => {
    const { fetchFn, stop } = setup([]);
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // RULES §7-1: токен сброшен (выход) - переподключения нет
  it('без токена поток не открывается и не переподключается', async () => {
    const { fetchFn, setToken } = setup([]);
    await flush();
    setToken(null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const none = setup([], null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(none.fetchFn).not.toHaveBeenCalled();
  });
});
