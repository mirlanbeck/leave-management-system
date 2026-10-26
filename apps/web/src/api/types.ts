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

/** GET /employees: справочник для выбора backstopper, без самого вошедшего. */
export interface EmployeeRef {
  id: number;
  fullName: string;
}

/** GET /me/balance?on=: дни кратно 0,5, даты YYYY-MM-DD; «сегодня» по Clock сервера. */
export interface Balance {
  employeeId: number;
  today: string;
  balance: number;
  on: string | null;
  availableOn: number | null;
}

/** Тело POST /vacations. */
export interface VacationInput {
  startDate: string;
  endDate: string;
  backstopperId: number | null;
  comment: string;
}

export type VacationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REPLACED';

/** Заявка (architecture §7, схема Vacation); поля, нужные интерфейсу. */
export interface Vacation {
  id: number;
  employee: EmployeeRef;
  backstopper: EmployeeRef;
  startDate: string;
  endDate: string;
  workDays: number;
  status: VacationStatus;
  comment: string | null;
  transferPending: boolean;
  oldVacationKept: boolean;
}

export interface LoginResult {
  accessToken: string;
  expiresAt: string;
}
