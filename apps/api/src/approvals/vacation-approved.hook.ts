import { Inject, Injectable } from '@nestjs/common';
import { companyToday, companyTz } from '../clock/company-tz';
import { APP_ENV, reminderDays } from '../config/app-config';
import { fromDbDate, lateReminderDue } from '../domain';
import type { Prisma } from '../generated/prisma/client';
import {
  enqueueDecisionMail,
  type DecidedVacation,
} from '../mail/decision-mail';
import {
  enqueueReminderMails,
  type ReminderVacation,
} from '../mail/reminder-mail';

/**
 * TxHook «заявка одобрена» (architecture §4, §9; DECISIONS 2026-10-22 19:04). Вызывается внутри
 * транзакции одобрения, после смены статуса; сбой откатывает решение целиком (RULES §10-1).
 * Письмо о решении (S5); с S6b вызывается и из утверждения переноса (то же письмо, писем о
 * старом отпуске нет, RULES §8-3). S7: немедленное напоминание при позднем одобрении, в том
 * числе при утверждении переноса по новым датам (RULES §8-3).
 */
@Injectable()
export class VacationApprovedHook {
  private readonly n: number;
  private readonly tz: string;

  constructor(@Inject(APP_ENV) env: NodeJS.ProcessEnv) {
    this.n = reminderDays(env);
    this.tz = companyTz(env);
  }

  async onVacationApproved(
    tx: Prisma.TransactionClient,
    vacation: DecidedVacation & ReminderVacation,
  ): Promise<void> {
    await enqueueDecisionMail(tx, vacation);
    // RULES §8-3: дата напоминания ≤ сегодня < начала — напоминание сразу, в любое время суток.
    // «Сегодня» и момент письма — из decidedAt: один момент Clock на решение и письма
    // (DECISIONS 2026-10-28 01:59). Плановое в 09:00 не дублируется: тот же ключ outbox.
    const decidedAt = vacation.decidedAt!;
    const today = companyToday(decidedAt, this.tz);
    if (lateReminderDue(fromDbDate(vacation.startDate), this.n, today)) {
      await enqueueReminderMails(tx, vacation, decidedAt);
    }
  }
}
