import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../clock/clock';
import { ApiError } from '../common/problem';

/** Часы лимита - системные, не демо-Clock: перевод демо-часов блокировку не снимает (RULES §9-1). */
export const LOGIN_LIMIT_CLOCK = 'LOGIN_LIMIT_CLOCK';

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

/** 429 при закрытом входе; одинаков для существующего и несуществующего логина (RULES §7-1). */
export class LoginLockedError extends ApiError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      429,
      'AUTH_TOO_MANY_ATTEMPTS',
      `Слишком много неудачных попыток входа. Повторите через ${Math.ceil(retryAfterSeconds / 60)} мин.`,
      { retryAfterSeconds },
    );
  }
}

interface Entry {
  /** Моменты неудач в окне, мс. */
  failures: number[];
  lockedUntil: number | null;
}

/** Ключ фиксированной длины: логин в DTO длиной не ограничен. */
function keyOf(login: string): string {
  return createHash('sha256').update(login).digest('base64');
}

/**
 * Счётчик неудачных входов по логину в памяти процесса (RULES §7-1, DECISIONS 2026-11-01 07:36):
 * 5 неудач за 15 минут закрывают вход на 15 минут. Перезапуск api счётчик сбрасывает.
 */
@Injectable()
export class LoginAttempts {
  private readonly entries = new Map<string, Entry>();

  constructor(@Inject(LOGIN_LIMIT_CLOCK) private readonly clock: Clock) {}

  /**
   * Проверяет блокировку и сразу засчитывает попытку неудачей, до bcrypt: между проверкой
   * и резервом нет await, поэтому параллельные запросы порог не обходят. Успех снимает резерв.
   */
  async begin(login: string): Promise<void> {
    const now = (await this.clock.now()).getTime();
    this.prune(now);
    const key = keyOf(login);
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: null };
    if (entry.lockedUntil !== null) {
      // попытки во время блокировки её не продлевают и не считаются
      throw new LoginLockedError(Math.ceil((entry.lockedUntil - now) / 1000));
    }
    entry.failures.push(now);
    if (entry.failures.length >= LOGIN_MAX_FAILURES) {
      entry.failures = [];
      entry.lockedUntil = now + LOGIN_LOCK_MS;
    }
    this.entries.set(key, entry);
  }

  /** Верный пароль (вход или 403 «до даты выхода») сбрасывает счётчик. */
  succeed(login: string): void {
    this.entries.delete(keyOf(login));
  }

  /** Число логинов со счётчиком (для проверки очистки). */
  get size(): number {
    return this.entries.size;
  }

  /** Снимает истёкшие блокировки и забывает неудачи старше окна. */
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil !== null && entry.lockedUntil <= now) {
        entry.lockedUntil = null;
      }
      entry.failures = entry.failures.filter((t) => now - t < LOGIN_WINDOW_MS);
      if (entry.lockedUntil === null && entry.failures.length === 0) {
        this.entries.delete(key);
      }
    }
  }
}
