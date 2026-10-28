import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  enqueueDecisionMail,
  type DecidedVacation,
} from '../mail/decision-mail';

/**
 * TxHook «заявка одобрена» (architecture §4, §9; DECISIONS 2026-10-22 19:04). Вызывается внутри
 * транзакции одобрения, после смены статуса; сбой откатывает решение целиком (RULES §10-1).
 * S5: письмо о решении; с S6b вызывается и из утверждения переноса (то же письмо, писем о старом
 * отпуске нет, RULES §8-3). S7 добавляет немедленное напоминание («сегодня» выводится из
 * vacation.decidedAt).
 */
@Injectable()
export class VacationApprovedHook {
  async onVacationApproved(
    tx: Prisma.TransactionClient,
    vacation: DecidedVacation,
  ): Promise<void> {
    await enqueueDecisionMail(tx, vacation);
  }
}
