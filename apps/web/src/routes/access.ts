import type { Profile } from '../api/types';

export type RoleFlags = Pick<Profile, 'isHr' | 'isManager'>;
export type RouteKey = 'home' | 'vacation' | 'approvals' | 'calendar' | 'hr';

export const ROUTE_PATHS: Record<RouteKey, string> = {
  home: '/',
  vacation: '/vacation',
  approvals: '/approvals',
  calendar: '/calendar',
  hr: '/hr',
};

export const ROUTE_TITLES: Record<RouteKey, string> = {
  home: 'Профиль',
  vacation: 'Отпуск',
  approvals: 'Согласование',
  calendar: 'Календарь',
  hr: 'HR',
};

/** Роль → маршруты (RULES §7-2). Руководитель определяется по прямым подчинённым, HR по признаку. */
const ACCESS: Record<RouteKey, (f: RoleFlags) => boolean> = {
  home: () => true,
  // у каждого свои дни, в том числе у HR и руководителей (RULES §7-1)
  vacation: () => true,
  approvals: (f) => f.isManager || f.isHr,
  // кого показать, решает сервер по видимости (RULES §7-2)
  calendar: () => true,
  hr: (f) => f.isHr,
};

export function canAccess(route: RouteKey, flags: RoleFlags): boolean {
  return ACCESS[route](flags);
}

export function allowedRoutes(flags: RoleFlags): RouteKey[] {
  return (Object.keys(ROUTE_PATHS) as RouteKey[]).filter((r) => canAccess(r, flags));
}
