/**
 * Точка расширения: вызывается после установки демо-часов, до ответа (RULES §9-4).
 * Провайдер — SchedulerModule: синхронный проход планировщика напоминаний (S7).
 */
export const AFTER_CLOCK_SET = Symbol('AFTER_CLOCK_SET');

export type AfterClockSet = (instant: Date) => Promise<void>;
