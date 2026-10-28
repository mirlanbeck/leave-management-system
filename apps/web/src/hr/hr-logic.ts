import type { Vacation } from '../api/types';
import { formatHireDate as formatDate } from '../profile/format';

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
