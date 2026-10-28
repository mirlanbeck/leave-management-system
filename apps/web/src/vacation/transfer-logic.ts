import type { Vacation } from '../api/types';
import { periodText } from '../approvals/approval-logic';
import type { VacationFormValues } from './submit-logic';

/** «Перенести» по подсказке сервера: владелец, одобренный отпуск до начала, перенос не ждёт решения (RULES §5-1, §5-2). */
export function canTransfer(v: Vacation): boolean {
  return v.actions.includes('transfer');
}

/**
 * Начальные значения формы «Перенести» (DECISIONS 2026-10-28 17:06): даты пустые, backstopper
 * старого отпуска подставлен и заменяем, комментарий необязателен (RULES §5-2).
 */
export function initialTransferForm(v: Pick<Vacation, 'backstopper'>): VacationFormValues {
  return { startDate: '', endDate: '', backstopperId: String(v.backstopper.id), comment: '' };
}

/** Подсказка в форме: те же рабочие дни, начало не раньше сегодня (RULES §5-2). */
export function transferHint(workDays: number): string {
  return `Рабочих дней должно быть столько же: ${workDays}. Начало — не раньше сегодняшнего дня.`;
}

/** Итог подачи переноса (DECISIONS 2026-10-28 17:06): старый отпуск в силе до решения (RULES §3-11). */
export function transferSuccessText(created: Pick<Vacation, 'startDate' | 'endDate'>): string {
  return `Перенос подан: ${periodText(created.startDate, created.endDate)}, статус «На согласовании». Старый отпуск действует до решения.`;
}
