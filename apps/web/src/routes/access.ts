import type { Profile } from '../api/types';

export type RoleFlags = Pick<Profile, 'isHr' | 'isManager'>;
export type RouteKey = 'home' | 'approvals' | 'hr';

export const ROUTE_PATHS: Record<RouteKey, string> = {
  home: '/',
  approvals: '/approvals',
  hr: '/hr',
};

export const ROUTE_TITLES: Record<RouteKey, string> = {
  home: 'Профиль',
  approvals: 'Согласование',
  hr: 'HR',
};

/** Роль → маршруты (RULES §7-2). Руководитель определяется по прямым подчинённым, HR по признаку. */
const ACCESS: Record<RouteKey, (f: RoleFlags) => boolean> = {
  home: () => true,
  approvals: (f) => f.isManager || f.isHr,
  hr: (f) => f.isHr,
};

export function canAccess(route: RouteKey, flags: RoleFlags): boolean {
  return ACCESS[route](flags);
}

export function allowedRoutes(flags: RoleFlags): RouteKey[] {
  return (Object.keys(ROUTE_PATHS) as RouteKey[]).filter((r) => canAccess(r, flags));
}
