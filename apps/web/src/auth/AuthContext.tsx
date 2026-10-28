import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedListener } from '../api';
import { ApiRequestError, toProblem, type ApiProblem } from '../api/problem';
import type { LoginResult, Profile } from '../api/types';
import { tokenStore } from './storage';

export type AuthStatus = 'loading' | 'anon' | 'authed' | 'error';

interface AuthValue {
  status: AuthStatus;
  profile: Profile | null;
  error: ApiProblem | null;
  /** Был ли сброс сессии из-за 401 (а не выход или первый заход). */
  sessionExpired: boolean;
  login(login: string, password: string): Promise<void>;
  logout(): void;
  reload(): void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(() => (tokenStore.get() ? 'loading' : 'anon'));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const loadProfile = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      setProfile(await api.get<Profile>('/me'));
      setStatus('authed');
    } catch (e) {
      // 401 уже обработан слушателем: токен сброшен, статус anon
      if (e instanceof ApiRequestError && e.problem.status === 401) return;
      setError(toProblem(e));
      setStatus('error');
    }
  }, []);

  // Слушатель регистрируется раньше первой загрузки профиля
  useEffect(() => {
    setUnauthorizedListener(() => {
      tokenStore.clear();
      setProfile(null);
      setSessionExpired(true);
      setStatus('anon');
    });
    return () => setUnauthorizedListener(null);
  }, []);

  useEffect(() => {
    if (tokenStore.get()) void loadProfile();
  }, [loadProfile]);

  const login = useCallback(
    async (loginName: string, password: string) => {
      const { accessToken } = await api.post<LoginResult>('/auth/login', {
        login: loginName,
        password,
      });
      tokenStore.set(accessToken);
      setSessionExpired(false);
      await loadProfile();
    },
    [loadProfile],
  );

  const logout = useCallback(() => {
    tokenStore.clear();
    setProfile(null);
    setSessionExpired(false);
    setError(null);
    setStatus('anon');
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      profile,
      error,
      sessionExpired,
      login,
      logout,
      reload: () => void loadProfile(),
    }),
    [status, profile, error, sessionExpired, login, logout, loadProfile],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth вне AuthProvider');
  return ctx;
}
