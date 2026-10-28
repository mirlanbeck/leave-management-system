import { describeProblem, toProblem } from '../api/problem';
import type { ApprovalItem, Overlap, Vacation } from '../api/types';
import { formatHireDate as formatDate } from '../profile/format';
import { formatDays, isNegativeDays } from '../vacation/format';

export type DecisionKind = 'approve' | 'reject';

export function periodText(startDate: string, endDate: string): string {
  return `${formatDate(startDate)}–${formatDate(endDate)}`;
}

/** Предупреждение о пересечениях с одобренными отпусками команды; не блокирует (RULES §4-6). */
export function overlapText(overlaps: Overlap[]): string | null {
  if (overlaps.length === 0) return null;
  const list = overlaps.map((o) => `${o.employee.fullName} ${periodText(o.startDate, o.endDate)}`);
  return `Пересекается с одобренными отпусками: ${list.join('; ')}`;
}

/**
 * «Доступно на дату начала» (RULES §4-7, §2-7); минус помечается (RULES §6-4). null только у
 * переноса: остаток не проверяется (RULES §5-2; DECISIONS 2026-10-28 17:06).
 */
export function availableText(days: number | null): { text: string; negative: boolean } {
  if (days === null) return { text: 'не проверяется (перенос)', negative: false };
  return { text: formatDays(days), negative: isNegativeDays(days) };
}

/** Плашка заявки-переноса на карточке согласования (DECISIONS 2026-10-28 17:06); старые даты не показываются. */
export function transferLabel(v: Pick<Vacation, 'replacesId'>): string | null {
  return v.replacesId === null ? null : 'Перенос одобренного отпуска';
}

export interface DecisionButtons {
  approveVisible: boolean;
  approveEnabled: boolean;
  rejectVisible: boolean;
  rejectEnabled: boolean;
  /** Причина, по которой подтвердить нельзя (текст сервера). */
  reason: string | null;
}

/**
 * Кнопки по подсказке сервера (RULES §4-1, §4-2). При нехватке дней подтвердить нельзя,
 * отклонить можно (RULES §4-3). Пока решение отправляется, обе недоступны (RULES §10-1).
 */
export function decisionButtons(item: ApprovalItem, busy: boolean): DecisionButtons {
  const approveVisible = item.vacation.actions.includes('approve');
  const rejectVisible = item.vacation.actions.includes('reject');
  return {
    approveVisible,
    approveEnabled: approveVisible && item.canApprove && !busy,
    rejectVisible,
    rejectEnabled: rejectVisible && !busy,
    reason: item.canApprove ? null : (item.blockReason?.message ?? null),
  };
}

/** Комментарий необязателен (RULES §4-1): пустой не отправляется, обрезку делает сервер. */
export function decisionBody(comment: string): { comment?: string } {
  return comment.trim() === '' ? {} : { comment };
}

export function successText(kind: DecisionKind, fullName: string): string {
  return `Заявка ${fullName} ${kind === 'approve' ? 'одобрена' : 'отклонена'}`;
}

export interface DecisionOutcome {
  tone: 'ok' | 'error';
  text: string;
}

/**
 * Отправляет решение и при любом исходе перечитывает список (DECISIONS [S5]): после 409
 * «уже обработана» (RULES §10-1), 422 и прочих ошибок очередь тоже могла измениться.
 */
export async function decideThenReload(
  send: () => Promise<unknown>,
  reload: () => void,
  success: string,
): Promise<DecisionOutcome> {
  let outcome: DecisionOutcome;
  try {
    await send();
    outcome = { tone: 'ok', text: success };
  } catch (e) {
    outcome = { tone: 'error', text: describeProblem(toProblem(e)) };
  }
  reload();
  return outcome;
}

/**
 * Одно решение на карточку (RULES §10-1): пока идёт запрос, следующий вызов (в том числе
 * другой кнопкой) не запускается и возвращает undefined.
 */
export function oneAtATime(): <T>(fn: () => Promise<T>) => Promise<T | undefined> {
  let busy = false;
  return async (fn) => {
    if (busy) return undefined;
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
}
