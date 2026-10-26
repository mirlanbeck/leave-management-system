import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../clock/clock';
import { companyToday, companyTz } from '../clock/company-tz';
import { APP_ENV } from '../config/app-config';
import { compareDates, fromDbDate } from '../domain';
import type { Prisma } from '../generated/prisma/client';
import { MailType, VacationStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { MailTransport, SMTP_SEND_MAX_MS } from './mail-transport';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_CONFIG,
  retryDelayMs,
  type OutboxConfig,
} from './outbox-config';

interface DueRow {
  id: number;
  type: MailType;
  subject: string;
  body: string;
  attempts: number;
  email: string;
  vacationStatus: VacationStatus;
  startDate: Date;
}

/** Транзакция прохода держится на время отправки пачки; запас на запросы к БД. */
const PASS_TIMEOUT_MS = OUTBOX_BATCH_SIZE * SMTP_SEND_MAX_MS + 10_000;

/**
 * Диспетчер outbox (architecture §10). Время попыток - системное время БД, не Clock
 * (RULES §9-1, DECISIONS 2026-10-22 12:21): выбор по now() начала транзакции, sentAt и
 * nextAttemptAt по clock_timestamp(), то есть по факту отправки. Clock нужен только для
 * «сегодня» в проверке напоминания (RULES §8-4).
 */
@Injectable()
export class OutboxDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transport: MailTransport,
    private readonly clock: Clock,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxConfig,
    @Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv,
  ) {}

  /**
   * Один проход: до OUTBOX_BATCH_SIZE писем под FOR UPDATE SKIP LOCKED (только строки outbox,
   * architecture §6), по очереди. При первом сбое отправки проход останавливается: остальные
   * строки не тронуты и уходят следующим проходом. Возвращает число обработанных строк
   * (отправлено, пропущено, отмечен сбой).
   */
  runOnce(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<DueRow[]>`
          SELECT o.id, o.type, o.subject, o.body, o.attempts, u.email,
                 v.status AS "vacationStatus", v."startDate"
          FROM "OutboxMessage" o
          JOIN "User" u ON u.id = o."recipientId"
          JOIN "Vacation" v ON v.id = o."vacationId"
          WHERE o.status = 'PENDING' AND o."nextAttemptAt" <= now()
          ORDER BY o."nextAttemptAt", o.id
          LIMIT ${OUTBOX_BATCH_SIZE}
          FOR UPDATE OF o SKIP LOCKED`;

        let today: string | undefined;
        let processed = 0;
        for (const row of rows) {
          if (row.type === MailType.REMINDER) {
            today ??= companyToday(await this.clock.now(), companyTz(this.env));
            if (!this.reminderStillDue(row, today)) {
              await tx.$executeRaw`
                UPDATE "OutboxMessage" SET status = 'SKIPPED' WHERE id = ${row.id}`;
              processed += 1;
              continue;
            }
          }
          try {
            await this.transport.send({
              from: this.config.mailFrom,
              to: row.email,
              subject: row.subject,
              text: row.body,
            });
          } catch (error) {
            await this.markFailed(tx, row, error);
            return processed + 1;
          }
          await tx.$executeRaw`
            UPDATE "OutboxMessage" SET status = 'SENT', "sentAt" = clock_timestamp()
            WHERE id = ${row.id}`;
          processed += 1;
        }
        return processed;
      },
      { timeout: PASS_TIMEOUT_MS },
    );
  }

  /**
   * RULES §8-3: напоминание уходит, только если отпуск «Одобрена» в момент отправки;
   * §8-4: и если дата начала ещё не наступила (сегодня по Clock и COMPANY_TZ).
   */
  private reminderStillDue(row: DueRow, today: string): boolean {
    return (
      row.vacationStatus === VacationStatus.APPROVED &&
      compareDates(today, fromDbDate(row.startDate)) < 0
    );
  }

  /** Сбой: попытка учтена, следующая через нарастающую паузу (лимита нет, DECISIONS [S4]). */
  private async markFailed(
    tx: Prisma.TransactionClient,
    row: DueRow,
    error: unknown,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const delayMs = retryDelayMs(
      attempts,
      this.config.retryBaseMs,
      this.config.retryMaxMs,
    );
    const message = error instanceof Error ? error.message : String(error);
    await tx.$executeRaw`
      UPDATE "OutboxMessage"
      SET attempts = ${attempts},
          "lastError" = ${message},
          "nextAttemptAt" = clock_timestamp() + make_interval(secs => ${delayMs / 1000}::float8)
      WHERE id = ${row.id}`;
  }
}
