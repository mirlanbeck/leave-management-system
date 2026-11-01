import { FakeClock } from '../clock/clock';
import {
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  LoginAttempts,
  LoginLockedError,
} from './login-attempts';

const MINUTE = 60 * 1000;

describe('LoginAttempts', () => {
  let clock: FakeClock;
  let attempts: LoginAttempts;

  const failTimes = async (login: string, n: number) => {
    for (let i = 0; i < n; i++) await attempts.begin(login);
  };
  /** null - попытка принята, иначе ошибка блокировки; другие ошибки пробрасываются. */
  const locked = async (login: string): Promise<LoginLockedError | null> => {
    try {
      await attempts.begin(login);
      return null;
    } catch (e) {
      if (e instanceof LoginLockedError) return e;
      throw e;
    }
  };

  beforeEach(() => {
    clock = new FakeClock('2026-10-24T03:00:00Z');
    attempts = new LoginAttempts(clock);
  });

  // RULES §7-1
  it('параметры: 5 неудач за 15 минут -> блокировка на 15 минут', () => {
    expect([LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_LOCK_MS]).toEqual([
      5,
      15 * MINUTE,
      15 * MINUTE,
    ]);
  });

  // RULES §7-1
  it('4 неудачи вход не закрывают, 5-я закрывает', async () => {
    await failTimes('ok', LOGIN_MAX_FAILURES - 1);
    expect(await locked('ok')).toBeNull(); // это 5-я
    const e = await locked('ok');
    expect(e).toBeInstanceOf(LoginLockedError);
    expect(e!.getStatus()).toBe(429);
    expect(e!.code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    expect(e!.retryAfterSeconds).toBe(15 * 60);
    expect(e!.message).toBe(
      'Слишком много неудачных попыток входа. Повторите через 15 мин.',
    );
    expect(e!.details).toEqual({ retryAfterSeconds: 15 * 60 });
  });

  // RULES §7-1: минуты в тексте округляются вверх
  it('Retry-After убывает, минуты в тексте округляются вверх', async () => {
    await failTimes('ok', LOGIN_MAX_FAILURES);
    clock.advanceMs(14 * MINUTE + 1000);
    const e = await locked('ok');
    expect(e!.retryAfterSeconds).toBe(59);
    expect(e!.message).toContain('Повторите через 1 мин.');
  });

  // RULES §7-1
  it('неудачи старше 15 минут забываются', async () => {
    await failTimes('ok', LOGIN_MAX_FAILURES - 1);
    clock.advanceMs(LOGIN_WINDOW_MS);
    await failTimes('ok', LOGIN_MAX_FAILURES - 1);
    expect(await locked('ok')).toBeNull();
  });

  // RULES §7-1: окно скользящее - неудача внутри окна учитывается
  it('неудачи внутри 15 минут складываются', async () => {
    await failTimes('ok', LOGIN_MAX_FAILURES - 1);
    clock.advanceMs(LOGIN_WINDOW_MS - 1);
    await failTimes('ok', 1);
    expect(await locked('ok')).toBeInstanceOf(LoginLockedError);
  });

  // RULES §7-1
  it('через 15 минут блокировка снимается, счёт начинается заново', async () => {
    await failTimes('ok', LOGIN_MAX_FAILURES);
    clock.advanceMs(LOGIN_LOCK_MS - 1);
    expect(await locked('ok')).toBeInstanceOf(LoginLockedError);
    clock.advanceMs(1);
    await failTimes('ok', LOGIN_MAX_FAILURES - 1);
    expect(await locked('ok')).toBeNull();
  });

  // RULES §7-1: попытки во время блокировки её не продлевают
  it('попытки во время блокировки срок не продлевают', async () => {
    await failTimes('ok', LOGIN_MAX_FAILURES);
    for (let i = 0; i < 10; i++) {
      clock.advanceMs(MINUTE);
      expect(await locked('ok')).toBeInstanceOf(LoginLockedError);
    }
    clock.advanceMs(LOGIN_LOCK_MS - 10 * MINUTE);
    expect(await locked('ok')).toBeNull();
  });

  // RULES §7-1
  it('успех сбрасывает счётчик', async () => {
    await failTimes('ok', LOGIN_MAX_FAILURES - 1);
    attempts.succeed('ok');
    await failTimes('ok', LOGIN_MAX_FAILURES - 1);
    expect(await locked('ok')).toBeNull();
  });

  // RULES §7-1: ключ - логин как прислан; другие логины не затронуты
  it('логины независимы, регистр различается', async () => {
    await failTimes('ok', LOGIN_MAX_FAILURES);
    expect(await locked('ok')).toBeInstanceOf(LoginLockedError);
    expect(await locked('other')).toBeNull();
    expect(await locked('OK')).toBeNull();
  });

  // RULES §7-1: проверка и резерв без await между ними
  it('параллельные попытки: ровно 5 проходят, остальные получают блокировку', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => locked('ok')),
    );
    expect(results.filter((r) => r === null)).toHaveLength(LOGIN_MAX_FAILURES);
    expect(results.filter((r) => r instanceof LoginLockedError)).toHaveLength(
      10 - LOGIN_MAX_FAILURES,
    );
  });

  // RULES §7-1: память не растёт от старых записей (в том числе несуществующих логинов)
  it('просроченные записи удаляются', async () => {
    await failTimes('a', 1);
    await failTimes('b', LOGIN_MAX_FAILURES);
    expect(attempts.size).toBe(2);
    clock.advanceMs(LOGIN_LOCK_MS);
    await failTimes('c', 1);
    expect(attempts.size).toBe(1);
  });
});
