import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox } from '../components/ErrorBox';
import { canAccess, ROUTE_PATHS, type RouteKey } from './access';

export interface LoginState {
  from?: string;
  expired?: boolean;
}

export function RequireAuth() {
  const { status, error, sessionExpired, reload, logout } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <p className="state">Загрузка…</p>;
  if (status === 'error' && error) {
    return (
      <div className="state">
        <ErrorBox problem={error} />
        <button type="button" onClick={reload}>
          Повторить
        </button>{' '}
        <button type="button" onClick={logout}>
          Выйти
        </button>
      </div>
    );
  }
  if (status === 'anon') {
    const state: LoginState = {
      from: location.pathname + location.search,
      expired: sessionExpired,
    };
    return <Navigate to="/login" replace state={state} />;
  }
  return <Outlet />;
}

/** Запретная страница редиректит на главную, а не просто прячет ссылку (RULES §7-2). */
export function RequireRole({ route }: { route: RouteKey }) {
  const { profile } = useAuth();
  if (!profile || !canAccess(route, profile)) {
    return <Navigate to={ROUTE_PATHS.home} replace />;
  }
  return <Outlet />;
}
