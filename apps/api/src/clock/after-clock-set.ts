/**
 * Точка расширения: вызывается после установки демо-часов, до ответа (RULES §9-4).
 * В S7 сюда подключается проход планировщика; сейчас ничего не делает.
 */
export const AFTER_CLOCK_SET = Symbol('AFTER_CLOCK_SET');

export type AfterClockSet = (instant: Date) => Promise<void>;

export const noopAfterClockSet: AfterClockSet = () => Promise.resolve();
