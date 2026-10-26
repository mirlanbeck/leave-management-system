import {
  DEFAULT_OUTBOX_CONFIG,
  OUTBOX_BATCH_SIZE,
  outboxConfig,
  retryDelayMs,
} from './outbox-config';

describe('outboxConfig: параметры диспетчера из окружения', () => {
  // RULES §9-1: диспетчер работает по системным часам, интервалы задаются env (DECISIONS 2026-10-26 00:43)
  it('без переменных - значения по умолчанию, пауза до 5 минут', () => {
    expect(outboxConfig({})).toEqual(DEFAULT_OUTBOX_CONFIG);
    expect(DEFAULT_OUTBOX_CONFIG).toEqual({
      pollMs: 2000,
      retryBaseMs: 5000,
      retryMaxMs: 300_000,
      mailFrom: 'Отпуска <noreply@vacation.local>',
      smtpHost: '127.0.0.1',
      smtpPort: 1025,
    });
    expect(OUTBOX_BATCH_SIZE).toBe(10);
  });

  // RULES §9-1
  it('значения из env', () => {
    expect(
      outboxConfig({
        OUTBOX_POLL_MS: '50',
        OUTBOX_RETRY_BASE_MS: '10',
        OUTBOX_RETRY_MAX_MS: '40',
        MAIL_FROM: 'test@example.local',
        SMTP_HOST: 'mailpit',
        SMTP_PORT: '2525',
      }),
    ).toEqual({
      pollMs: 50,
      retryBaseMs: 10,
      retryMaxMs: 40,
      mailFrom: 'test@example.local',
      smtpHost: 'mailpit',
      smtpPort: 2525,
    });
  });

  // RULES §9-1: неверное значение останавливает старт, а не превращается в NaN-паузу
  it.each([
    ['OUTBOX_POLL_MS', '0'],
    ['OUTBOX_POLL_MS', '-5'],
    ['OUTBOX_POLL_MS', '1.5'],
    ['OUTBOX_POLL_MS', 'abc'],
    ['OUTBOX_RETRY_BASE_MS', '0'],
    ['OUTBOX_RETRY_MAX_MS', '1e3'],
    ['SMTP_PORT', '0'],
    ['SMTP_PORT', '65536'],
  ])('%s=%s - ошибка с именем переменной', (name, value) => {
    expect(() => outboxConfig({ [name]: value })).toThrow(name);
  });

  // RULES §9-1
  it('база паузы больше максимума - ошибка', () => {
    expect(() =>
      outboxConfig({ OUTBOX_RETRY_BASE_MS: '600', OUTBOX_RETRY_MAX_MS: '500' }),
    ).toThrow('OUTBOX_RETRY_BASE_MS');
  });

  // RULES §9-1: пустая строка в compose означает «по умолчанию»
  it('пустые значения - по умолчанию', () => {
    expect(
      outboxConfig({ OUTBOX_POLL_MS: '', MAIL_FROM: '', SMTP_HOST: '' }),
    ).toEqual(DEFAULT_OUTBOX_CONFIG);
  });
});

describe('retryDelayMs: нарастающая пауза между повторами', () => {
  // RULES §9-1, §10-1: повтор при недоступном получателе, пауза растёт до потолка
  it('удваивается от базы и упирается в максимум', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      retryDelayMs(n, 5000, 300_000),
    );
    expect(delays).toEqual([
      5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000,
    ]);
  });

  // RULES §9-1: лимита попыток нет, поэтому attempts может быть сколь угодно большим
  it.each([60, 1000, 2_147_483_647])(
    'attempts=%i - конечное число, равное максимуму',
    (attempts) => {
      expect(retryDelayMs(attempts, 5000, 300_000)).toBe(300_000);
    },
  );

  // RULES §9-1
  it('attempts меньше 1 - ошибка', () => {
    expect(() => retryDelayMs(0, 5000, 300_000)).toThrow(RangeError);
  });
});
