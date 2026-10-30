/** Паузы переподключения, мс; дальше последняя, без лимита попыток (DECISIONS 2026-10-29 22:26). */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export interface StreamDeps {
  fetchFn: typeof fetch;
  getToken: () => string | null;
  /** Тот же обработчик, что у ApiClient: 401 по токену, который всё ещё текущий (RULES §7-1). */
  onUnauthorized: () => void;
  baseUrl?: string;
}

export interface StreamHandlers {
  onEvent(type: string, data: unknown): void;
  /** Поток открыт (200); вызывается на каждое успешное подключение. */
  onOpen(): void;
  /** Подключение не удалось или оборвалось, назначен повтор. */
  onDrop(): void;
}

/**
 * Разбор кадров SSE: кадр кончается пустой строкой, чанк может резать кадр где угодно.
 * Комментарии (`: keep-alive`) пропускаются; битый JSON в data - кадр без данных не отдаётся.
 */
export function createFrameParser(onFrame: (type: string, data: unknown) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let type: string | undefined;
        let raw: string | undefined;
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') type = value;
          else if (field === 'data') raw = value;
        }
        if (type === undefined) continue;
        if (raw === undefined) {
          onFrame(type, undefined);
          continue;
        }
        try {
          onFrame(type, JSON.parse(raw));
        } catch {
          // кадр с битыми данными пропускается
        }
      }
    },
  };
}

/**
 * Поток `GET /events` через fetch с `Authorization` (токен в URL не передаётся, RULES §7-1).
 * Обрыв, сетевой сбой и 5xx - повтор с паузой 1→2→4→8→16→30 с, пауза сбрасывается после
 * успешного подключения. 401 - onUnauthorized (если токен ещё текущий) и без повторов.
 * Возвращает stop(): прерывает поток и отменяет повтор (выход, размонтирование).
 */
export function openEventStream(deps: StreamDeps, handlers: StreamHandlers): () => void {
  const url = `${deps.baseUrl ?? '/api'}/events`;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;

  function retry() {
    if (stopped) return;
    handlers.onDrop();
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
    failures += 1;
    timer = setTimeout(() => void connect(), delay);
  }

  async function connect() {
    timer = undefined;
    const token = deps.getToken();
    if (stopped || !token) return;
    abort = new AbortController();
    let res: Response;
    try {
      res = await deps.fetchFn(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: abort.signal,
      });
    } catch {
      retry();
      return;
    }
    if (stopped) {
      void res.body?.cancel().catch(() => {});
      return;
    }
    if (res.status === 401) {
      stopped = true;
      if (token === deps.getToken()) deps.onUnauthorized();
      return;
    }
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => {});
      retry();
      return;
    }

    failures = 0;
    handlers.onOpen();
    const parser = createFrameParser((type, data) => {
      if (!stopped) handlers.onEvent(type, data);
    });
    const reader = res.body.getReader();
    const signal = abort.signal;
    signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // обрыв соединения или stop()
    }
    retry();
  }

  void connect();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    abort?.abort();
  };
}
