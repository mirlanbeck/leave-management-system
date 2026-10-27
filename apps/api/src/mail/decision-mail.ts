import { fromDbDate } from '../domain';
import type { Prisma } from '../generated/prisma/client';
import { MailType, VacationStatus } from '../generated/prisma/enums';
import { decisionMail } from './mail-templates';
import { enqueueMail } from './outbox';

/** Заявка сразу после решения: то, что нужно письму (подмножество строки с VACATION_INCLUDE). */
export interface DecidedVacation {
  id: number;
  employeeId: number;
  startDate: Date;
  endDate: Date;
  workDays: number;
  status: VacationStatus;
  decidedAt: Date | null;
  decisionComment: string | null;
  employee: { managerId: number | null };
  decidedBy: { fullName: string } | null;
}

/**
 * Ставит письмо DECISION в транзакции решения (RULES §8-2, §10-1). Получатель - автор заявки:
 * сотрудник, директор, HR по своей заявке (§8-6); backstopper и HR-наблюдатель не получают.
 * createdAt = decidedAt: один момент Clock на решение и письмо (RULES §9-1).
 */
export async function enqueueDecisionMail(
  tx: Pick<Prisma.TransactionClient, 'outboxMessage'>,
  v: DecidedVacation,
): Promise<void> {
  const decided =
    v.status === VacationStatus.APPROVED ||
    v.status === VacationStatus.REJECTED;
  if (!decided || !v.decidedAt || !v.decidedBy) {
    throw new Error(`Заявка ${v.id} без решения: письмо DECISION не ставится`);
  }
  await enqueueMail(
    tx,
    [
      {
        type: MailType.DECISION,
        vacationId: v.id,
        recipientId: v.employeeId,
        ...decisionMail({
          startDate: fromDbDate(v.startDate),
          endDate: fromDbDate(v.endDate),
          workDays: v.workDays,
          decision:
            v.status === VacationStatus.APPROVED ? 'approved' : 'rejected',
          deciderName: v.decidedBy.fullName,
          comment: v.decisionComment,
          forHr: v.employee.managerId === null,
        }),
      },
    ],
    v.decidedAt,
  );
}
