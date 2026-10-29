import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Response } from 'express';
import { SystemClock } from '../clock/clock';
import { OrgService } from '../org/org.service';
import { EventBus, type DomainEvent } from './event-bus';
import { deliver } from './event-filter';

export interface SseOptions {
  /** Интервал комментария `: keep-alive`, мс (nginx не закрывает простаивающее соединение). */
  keepAliveMs: number;
}

export const SSE_OPTIONS = Symbol('SSE_OPTIONS');
export const DEFAULT_SSE_OPTIONS: SseOptions = { keepAliveMs: 25_000 };

interface Connection {
  viewerId: number;
  res: Response;
  timers: NodeJS.Timeout[];
}

/**
 * Подключённые потоки `GET /events` (architecture §9). События обрабатываются строго по одному
 * в одной очереди: порядок сохраняется. На событие структура читается один раз, зритель берётся
 * из неё (не из токена), фильтр - `deliver` (RULES §7-2, §10-2). Адресаты фиксируются в момент
 * публикации: подключившийся позже события не получает. Сбой обработки пишется в лог.
 */
@Injectable()
export class SseHub implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SseHub');
  private readonly connections = new Set<Connection>();
  // срок токена считается по системным часам, как проверка JWT (jwt-config.ts), не по Clock
  private readonly systemClock = new SystemClock();
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;

  constructor(
    private readonly bus: EventBus,
    private readonly org: OrgService,
    @Inject(SSE_OPTIONS) private readonly options: SseOptions,
  ) {}

  /** Число открытых потоков (для проверки утечек). */
  get size(): number {
    return this.connections.size;
  }

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((event) => this.enqueue(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    for (const conn of [...this.connections]) this.drop(conn, true);
  }

  /**
   * Регистрирует открытый поток: keep-alive, закрытие в момент `exp` токена (RULES §7-1),
   * отписка при отключении клиента.
   */
  async connect(res: Response, viewerId: number, exp?: number): Promise<void> {
    const conn: Connection = { viewerId, res, timers: [] };
    this.connections.add(conn);
    res.on('close', () => this.drop(conn, false));

    conn.timers.push(
      setInterval(
        () => res.write(': keep-alive\n\n'),
        this.options.keepAliveMs,
      ),
    );
    if (exp !== undefined) {
      const left = exp * 1000 - (await this.systemClock.now()).getTime();
      // клиент мог отключиться, пока читались часы: таймер не нужен
      if (!this.connections.has(conn)) return;
      conn.timers.push(
        setTimeout(() => this.drop(conn, true), Math.max(0, left)),
      );
    }
  }

  private enqueue(event: DomainEvent): void {
    const targets = [...this.connections];
    this.queue = this.queue
      .then(() => this.dispatch(event, targets))
      .catch((e: unknown) => {
        this.logger.error(
          `событие ${event.type}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }

  private async dispatch(
    event: DomainEvent,
    targets: Connection[],
  ): Promise<void> {
    const org = await this.org.structure();
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const conn of targets) {
      if (this.connections.has(conn) && deliver(event, conn.viewerId, org)) {
        conn.res.write(frame);
      }
    }
  }

  private drop(conn: Connection, end: boolean): void {
    if (!this.connections.delete(conn)) return;
    for (const t of conn.timers) clearTimeout(t);
    if (end) conn.res.end();
  }
}
