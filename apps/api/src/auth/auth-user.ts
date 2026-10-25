import type { CalendarDate } from '../domain/calendar-date';

/** Пользователь, найденный по токену; кладётся в request.user. */
export interface AuthUser {
  id: number;
  login: string;
  fullName: string;
  hireDate: CalendarDate;
  teamName: string | null;
  managerId: number | null;
  isHr: boolean;
  accessGranted: boolean;
}

/** Поиск пользователя для guard (на каждый запрос, без кэша). */
export abstract class AuthUsers {
  abstract findById(id: number): Promise<AuthUser | null>;
}
