import type { Vacation } from '../api/types';
import { periodText } from '../approvals/approval-logic';

/** «Отменить» показывается по подсказке сервера: владелец, до начала (RULES §5-4, §5-7, §5-10). */
export function canCancel(v: Vacation): boolean {
  return v.actions.includes('cancel');
}

/**
 * Вопрос перед отменой (DECISIONS 2026-10-28 15:41). У одобренного отпуска дни вернутся
 * полностью; у заявки «На согласовании» дни не списывались (RULES §5-4).
 */
export function cancelConfirmText(v: Vacation): string {
  const period = periodText(v.startDate, v.endDate);
  return v.status === 'APPROVED'
    ? `Отменить отпуск ${period}? ${v.workDays} раб. дн. вернутся в остаток.`
    : `Отменить заявку ${period}? Дни не списывались.`;
}

export function cancelSuccessText(v: Vacation): string {
  return v.status === 'APPROVED' ? 'Отпуск отменён, дни возвращены в остаток' : 'Заявка отменена';
}
