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

/** Подсказка сервера, что зрителю можно сейчас; права проверяет сервер (architecture §7). */
export type VacationAction = 'cancel' | 'transfer' | 'recall' | 'approve' | 'reject';

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
  /** Заявка-перенос: id отпуска, который она переносит (RULES §5-12); иначе null. */
  replacesId: number | null;
  transferPending: boolean;
  oldVacationKept: boolean;
  actions: VacationAction[];
}

/** Одобренный отпуск команды на пересекающиеся даты (RULES §4-6). */
export interface Overlap {
  vacationId: number;
  employee: EmployeeRef;
  startDate: string;
  endDate: string;
}

/** GET /approvals (architecture §7, схема ApprovalItem). */
export interface ApprovalItem {
  vacation: Vacation;
  /** «Доступно на дату начала»; null у переноса (S6b). */
  availableOnStart: number | null;
  overlaps: Overlap[];
  canApprove: boolean;
  /** Почему подтвердить нельзя; тот же текст, что в ответе approve. */
  blockReason: { statusCode: number; code: string; message: string } | null;
}

/** Одобренный отпуск в календаре (architecture §7, Calendar.entries); даты полные. */
export interface CalendarEntry {
  vacationId: number;
  employee: EmployeeRef;
  teamName: string | null;
  startDate: string;
  endDate: string;
}

/** Остаток прямого подчинённого на сегодня (Calendar.balances, только у руководителя). */
export interface CalendarBalance {
  employee: EmployeeRef;
  balance: number;
}

/** GET /calendar?from&to: только «Одобрена», по видимости зрителя (RULES §7-2). */
export interface Calendar {
  entries: CalendarEntry[];
  balances?: CalendarBalance[];
}

export interface LoginResult {
  accessToken: string;
  expiresAt: string;
}
