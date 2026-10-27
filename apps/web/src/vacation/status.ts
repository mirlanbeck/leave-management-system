import type { VacationStatus } from '../api/types';

/** Статусы заявки по-русски (RULES §3-11). Пометки переноса выводятся в S6 (DECISIONS 2026-10-26 15:58). */
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
