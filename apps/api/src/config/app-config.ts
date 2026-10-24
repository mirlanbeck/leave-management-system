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
