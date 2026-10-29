// Тестовый клиент SSE на Node fetch (как fetch-stream в браузере): токен только в заголовке,
// кадры разбираются по пустой строке, комментарии (`: keep-alive`) отдельно от событий.
// Не попадает в сборку (tsconfig.build.json).

export interface SseEvent {
  event: string;
  data: unknown;
}

export class SseClient {
  private buffer = '';
  private readonly events: SseEvent[] = [];
  private readonly comments: string[] = [];
  private waiters: (() => void)[] = [];
  private done = false;
  /** Завершается, когда сервер закрыл поток (или клиент оборвал его сам). */
  readonly ended: Promise<void>;

  private constructor(
    readonly status: number,
    readonly headers: Headers,
    private readonly response: Response,
    private readonly abort: AbortController,
  ) {
    this.ended = status === 200 ? this.pump() : Promise.resolve();
  }

  /** Открывает поток; при статусе не 200 тело остаётся непрочитанным (см. `json()`). */
  static async open(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<SseClient> {
    const abort = new AbortController();
    const res = await fetch(url, { headers, signal: abort.signal });
    return new SseClient(res.status, res.headers, res, abort);
  }

  json(): Promise<unknown> {
    return this.response.json();
  }

  /** Следующее событие; ждёт, пока оно придёт. Падает, если поток закрылся раньше. */
  async next(): Promise<SseEvent> {
    while (this.events.length === 0) {
      if (this.done) throw new Error('поток закрыт, событий больше нет');
      await this.changed();
    }
    return this.events.shift()!;
  }

  /** Следующий комментарий (keep-alive). */
  async nextComment(): Promise<string> {
    while (this.comments.length === 0) {
      if (this.done) throw new Error('поток закрыт, комментариев больше нет');
      await this.changed();
    }
    return this.comments.shift()!;
  }

  /** Обрыв соединения со стороны клиента. */
  async close(): Promise<void> {
    this.abort.abort();
    await this.ended;
  }

  private changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.response
        .body! as AsyncIterable<Uint8Array>) {
        this.buffer += decoder.decode(chunk, { stream: true });
        this.parse();
      }
    } catch {
      // AbortError при close() или обрыв сервером - поток закончен
    } finally {
      this.done = true;
      this.wake();
    }
  }

  private parse(): void {
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event: string | undefined;
      let data: string | undefined;
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) this.comments.push(line.slice(1).trim());
        else if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (event !== undefined) {
        this.events.push({
          event,
          data: data === undefined ? undefined : JSON.parse(data),
        });
      }
    }
    this.wake();
  }
}
