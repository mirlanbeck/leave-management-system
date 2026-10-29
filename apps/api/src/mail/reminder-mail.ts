import { fromDbDate } from '../domain';
import type { Prisma } from '../generated/prisma/client';
import { MailType } from '../generated/prisma/enums';
import { reminderMail } from './mail-templates';
import { enqueueMail, type OutboxDraft } from './outbox';

/** Одобренный отпуск: то, что нужно напоминанию (подмножество строки с VACATION_INCLUDE). */
export interface ReminderVacation {
  id: number;
  employeeId: number;
  startDate: Date;
  endDate: Date;
  workDays: number;
  employee: { fullName: string; managerId: number | null };
  backstopper: { fullName: string };
}

/** Поля Vacation для выборки планировщика под ReminderVacation. */
export const REMINDER_SELECT = {
  id: true,
  employeeId: true,
  startDate: true,
  endDate: true,
  workDays: true,
  employee: { select: { fullName: true, managerId: true } },
  backstopper: { select: { fullName: true } },
} satisfies Prisma.VacationSelect;

/**
 * Ставит REMINDER сотруднику и его руководителю, по одному (RULES §8-3, §8-5). У директора
 * руководителя нет — только он сам; по своему отпуску HR — обычный сотрудник, её руководитель
 * (заместитель директора) тоже получает (§8-6). Backstopper не получает. Ключ «тип + отпуск +
 * получатель» и ON CONFLICT DO NOTHING (enqueueMail) не дают дубля с планировщиком, при
 * перезапуске и откате часов (§10-1). Получатель-руководитель — текущий `managerId`
 * (DECISIONS 2026-10-29 10:49). Статус «Одобрена» проверяет диспетчер при отправке (§8-3).
 */
export async function enqueueReminderMails(
  tx: Pick<Prisma.TransactionClient, 'outboxMessage'>,
  v: ReminderVacation,
  createdAt: Date,
): Promise<void> {
  const content = (toManager: boolean) =>
    reminderMail({
      employeeName: v.employee.fullName,
      startDate: fromDbDate(v.startDate),
      endDate: fromDbDate(v.endDate),
      workDays: v.workDays,
      backstopperName: v.backstopper.fullName,
      toManager,
    });
  const drafts: OutboxDraft[] = [
    {
      type: MailType.REMINDER,
      vacationId: v.id,
      recipientId: v.employeeId,
      ...content(false),
    },
  ];
  if (v.employee.managerId !== null) {
    drafts.push({
      type: MailType.REMINDER,
      vacationId: v.id,
      recipientId: v.employee.managerId,
      ...content(true),
    });
  }
  await enqueueMail(tx, drafts, createdAt);
}
