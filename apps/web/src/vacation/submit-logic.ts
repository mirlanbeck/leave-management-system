import type { VacationInput } from '../api/types';

export interface VacationFormValues {
  startDate: string;
  endDate: string;
  /** id из справочника строкой; '' - не выбран. */
  backstopperId: string;
  comment: string;
}

/**
 * Форма уходит на сервер как есть: проверок на клиенте нет, причину объясняет сервер
 * (RULES §3-2, §3-4…§3-12). Невыбранный backstopper - null (422 BACKSTOPPER_REQUIRED).
 */
export function toVacationInput(form: VacationFormValues): VacationInput {
  return {
    startDate: form.startDate,
    endDate: form.endDate,
    backstopperId: form.backstopperId === '' ? null : Number(form.backstopperId),
    comment: form.comment,
  };
}

/** Пока запрос идёт, повторный вызов возвращает тот же запрос, а не новый (RULES §10-1). */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = fn().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
