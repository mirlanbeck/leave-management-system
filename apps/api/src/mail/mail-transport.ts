import { createTransport, type Transporter } from 'nodemailer';
import type { OutboxConfig } from './outbox-config';

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** Отправка одного письма; ошибка - исключение. Тесты подменяют провайдер (architecture §10). */
export abstract class MailTransport {
  abstract send(mail: OutgoingMail): Promise<void>;
}

/**
 * Таймауты SMTP короткие: диспетчер держит транзакцию с блокировкой строк outbox на время отправки,
 * зависший сервер не должен держать её минутами (умолчания nodemailer - 2 и 10 минут).
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10_000,
} as const;

/** Худшее время одной отправки: соединение, приветствие, обмен. */
export const SMTP_SEND_MAX_MS =
  SMTP_TIMEOUTS.connectionTimeout +
  SMTP_TIMEOUTS.greetingTimeout +
  SMTP_TIMEOUTS.socketTimeout;

/** SMTP без авторизации и TLS (Mailpit, RULES §8-1). */
export class SmtpMailTransport extends MailTransport {
  private readonly transporter: Transporter;

  constructor(config: Pick<OutboxConfig, 'smtpHost' | 'smtpPort'>) {
    super();
    this.transporter = createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: false,
      ...SMTP_TIMEOUTS,
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    await this.transporter.sendMail(mail);
  }
}
