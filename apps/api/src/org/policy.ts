// Единственное место логики видимости (RULES §7-2, §7-3). Чистые функции: прямых
// подчинённых и структуру подаёт вызывающий (OrgService), состояние здесь не хранится.

export interface OrgUser {
  id: number;
  isHr: boolean;
  managerId: number | null;
}

export interface Roles {
  isHr: boolean;
  isManager: boolean;
  isDirector: boolean;
}

export function rolesOf(user: OrgUser, directReportIds: number[]): Roles {
  return {
    isHr: user.isHr,
    isManager: directReportIds.length > 0,
    isDirector: user.managerId === null,
  };
}

/**
 * Согласующий заявки сотрудника (RULES §4-1, §4-2): непосредственный руководитель,
 * у директора (начальника нет) HR («допуск HR»). Одна функция для писем и экрана согласования.
 */
export function approverOf(
  employee: Pick<OrgUser, 'managerId'>,
  hrId: number,
): number {
  return employee.managerId ?? hrId;
}

/** Кого видит зритель: 'ALL' (HR) или набор id (он сам и прямые подчинённые). */
export type Scope = 'ALL' | Set<number>;

export function scope(viewer: OrgUser, directReportIds: number[]): Scope {
  if (viewer.isHr) return 'ALL';
  return new Set([viewer.id, ...directReportIds]);
}

export function canSee(
  viewer: OrgUser,
  directReportIds: number[],
  employeeId: number,
): boolean {
  const s = scope(viewer, directReportIds);
  return s === 'ALL' || s.has(employeeId);
}
