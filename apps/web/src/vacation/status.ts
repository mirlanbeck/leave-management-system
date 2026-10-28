import type { Vacation, VacationStatus } from '../api/types';

/** Статусы заявки по-русски (RULES §3-11). Пометки переноса - marksText (S6b, DECISIONS 2026-10-26 15:58). */
export const STATUS_LABELS: Record<VacationStatus, string> = {
  PENDING: 'На согласовании',
  APPROVED: 'Одобрена',
  REJECTED: 'Отклонена',
  CANCELLED: 'Отменена',
  REPLACED: 'Заменена переносом',
};

/** Неизвестный код показывается как есть, чтобы расхождение с сервером было видно. */
export function statusLabel(status: string): string {
  return (STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/** Пометки заявки (RULES §3-11): выводит сервер, здесь только текст. */
export function marksText(v: Pick<Vacation, 'transferPending' | 'oldVacationKept'>): string {
  const marks: string[] = [];
  if (v.transferPending) marks.push('перенос на рассмотрении');
  if (v.oldVacationKept) marks.push('Старый отпуск остаётся');
  return marks.join('; ');
}

/** Статус с пометками в одной ячейке через «·» (DECISIONS 2026-10-28 17:06). */
export function statusWithMarks(v: Pick<Vacation, 'status' | 'transferPending' | 'oldVacationKept'>): string {
  const marks = marksText(v);
  return marks ? `${statusLabel(v.status)} · ${marks}` : statusLabel(v.status);
}
