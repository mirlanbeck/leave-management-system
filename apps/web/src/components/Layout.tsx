import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { DemoClockStrip } from '../clock/DemoClockStrip';
import { LiveEvents } from '../live/LiveEvents';
import { allowedRoutes, ROUTE_PATHS, ROUTE_TITLES } from '../routes/access';

export function Layout() {
  const { profile, logout } = useAuth();
  return (
    <LiveEvents>
      <DemoClockStrip />
      <header className="topbar">
        <strong>Отпуска</strong>
        {profile && (
          <nav aria-label="Разделы">
            {allowedRoutes(profile).map((route) => (
              <NavLink key={route} to={ROUTE_PATHS[route]} end>
                {ROUTE_TITLES[route]}
              </NavLink>
            ))}
          </nav>
        )}
        <span className="spacer" />
        {profile && <span data-testid="current-user">{profile.fullName}</span>}
        <button type="button" onClick={logout}>
          Выйти
        </button>
      </header>
      <main>
        <Outlet />
      </main>
    </LiveEvents>
  );
}
