/** GET /me (architecture §7). Дата выхода: YYYY-MM-DD. */
export interface Profile {
  id: number;
  fullName: string;
  hireDate: string;
  teamName: string | null;
  manager: { id: number; fullName: string } | null;
  isHr: boolean;
  isManager: boolean;
}

/** GET /config (публичный). */
export interface PublicConfig {
  demoMode: boolean;
  companyTz: string;
}

/** GET и PUT /clock (только при демо-режиме): момент UTC и признак «остановлены». */
export interface ClockView {
  now: string;
  frozen: boolean;
}

export interface LoginResult {
  accessToken: string;
  expiresAt: string;
}
