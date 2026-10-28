import type { Vacation } from '../api/types';
import { formatHireDate as formatDate } from '../profile/format';

/** Пометки заявки (RULES §3-11): выводит сервер, здесь только текст; до S6b всегда пусто. */
export function marksText(v: Pick<Vacation, 'transferPending' | 'oldVacationKept'>): string {
  const marks: string[] = [];
  if (v.transferPending) marks.push('перенос на рассмотрении');
  if (v.oldVacationKept) marks.push('Старый отпуск остаётся');
  return marks.join('; ');
}

/** «Отзыв» по подсказке сервера: HR, одобренный отпуск идёт (RULES §5-5; DECISIONS 2026-10-28 15:41). */
export function canRecall(v: Vacation): boolean {
  return v.actions.includes('recall');
}

/** Подсказка в форме отзыва (RULES §5-6). */
export function recallHint(endDate: string): string {
  return `Возвращаются рабочие дни с даты выхода по ${formatDate(endDate)} включительно; день выхода — рабочий.`;
}

/**
 * Можно ли отправить форму: дата выбрана и лежит в отпуске (RULES §5-11). Только подсказка
 * кнопке; проверяет сервер. Даты ISO, поэтому строки сравниваются как даты.
 */
export function canSubmitRecall(returnDate: string, v: Pick<Vacation, 'startDate' | 'endDate'>): boolean {
  return returnDate !== '' && returnDate >= v.startDate && returnDate <= v.endDate;
}

export function recallBody(returnDate: string): { returnDate: string } {
  return { returnDate };
}

export function recallSuccessText(fullName: string, returnDate: string): string {
  return `${fullName}: отзыв оформлен, дата выхода ${formatDate(returnDate)}`;
}
