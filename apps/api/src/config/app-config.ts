import { companyTz } from '../clock/company-tz';

/** Токен внедрения окружения: тесты подменяют его, не трогая process.env. */
export const APP_ENV = 'APP_ENV';

/** Демо-режим включается только строгим значением "true" (RULES §9-2). */
export function isDemoMode(env: NodeJS.ProcessEnv): boolean {
  return env.DEMO_MODE === 'true';
}

export interface PublicConfig {
  demoMode: boolean;
  companyTz: string;
}

export function publicConfig(env: NodeJS.ProcessEnv): PublicConfig {
  return { demoMode: isDemoMode(env), companyTz: companyTz(env) };
}

export const DEFAULT_REMINDER_DAYS = 3;

/**
 * N рабочих дней до начала отпуска для напоминания: REMINDER_DAYS, по умолчанию 3 (RULES §8-3).
 * Не целое число ≥ 1 — ошибка при старте, а не молчаливое значение по умолчанию.
 */
export function reminderDays(env: NodeJS.ProcessEnv): number {
  const raw = env.REMINDER_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_REMINDER_DAYS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`REMINDER_DAYS должно быть целым не меньше 1: "${raw}"`);
  }
  return Number(raw);
}
