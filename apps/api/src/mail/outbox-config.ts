/** Токен внедрения параметров диспетчера outbox. */
export const OUTBOX_CONFIG = 'OUTBOX_CONFIG';

/** Сколько писем один проход диспетчера берёт под блокировку (DECISIONS [S4]: константа, без env). */
export const OUTBOX_BATCH_SIZE = 10;

/**
 * Параметры диспетчера (RULES §9-1: системные часы; DECISIONS 2026-10-26 00:43: повторы без лимита,
 * пауза до 5 минут, параметры в env, чтобы тесты не ждали).
 */
export interface OutboxConfig {
  pollMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  mailFrom: string;
  smtpHost: string;
  smtpPort: number;
}

export const DEFAULT_OUTBOX_CONFIG: Readonly<OutboxConfig> = {
  pollMs: 2000,
  retryBaseMs: 5000,
  retryMaxMs: 300_000,
  mailFrom: 'Отпуска <noreply@vacation.local>',
  smtpHost: '127.0.0.1',
  smtpPort: 1025,
};

function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= 1 && value <= max)) {
    throw new Error(
      `${name}: ожидается целое число от 1 до ${max}, получено "${raw}"`,
    );
  }
  return value;
}

/** Параметры из окружения; неверное значение останавливает старт приложения. */
export function outboxConfig(env: NodeJS.ProcessEnv): OutboxConfig {
  const d = DEFAULT_OUTBOX_CONFIG;
  const config: OutboxConfig = {
    pollMs: positiveInt(env, 'OUTBOX_POLL_MS', d.pollMs),
    retryBaseMs: positiveInt(env, 'OUTBOX_RETRY_BASE_MS', d.retryBaseMs),
    retryMaxMs: positiveInt(env, 'OUTBOX_RETRY_MAX_MS', d.retryMaxMs),
    mailFrom: env.MAIL_FROM || d.mailFrom,
    smtpHost: env.SMTP_HOST || d.smtpHost,
    smtpPort: positiveInt(env, 'SMTP_PORT', d.smtpPort, 65535),
  };
  if (config.retryBaseMs > config.retryMaxMs) {
    throw new Error(
      `OUTBOX_RETRY_BASE_MS (${config.retryBaseMs}) больше OUTBOX_RETRY_MAX_MS (${config.retryMaxMs})`,
    );
  }
  return config;
}

/**
 * Пауза перед следующей попыткой после `attempts` неудачных: база, удваивается, не больше максимума.
 * Лимита попыток нет (DECISIONS 2026-10-26 00:43), поэтому степень ограничена до переполнения.
 */
export function retryDelayMs(
  attempts: number,
  baseMs: number,
  maxMs: number,
): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(
      `attempts должно быть целым >= 1, получено ${attempts}`,
    );
  }
  const exponent = Math.min(attempts - 1, 40);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
