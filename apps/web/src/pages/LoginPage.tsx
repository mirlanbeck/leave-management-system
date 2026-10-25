import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { toProblem, type ApiProblem } from '../api/problem';
import { useAuth } from '../auth/AuthContext';
import { safeReturnPath } from '../auth/return-path';
import { ErrorBox } from '../components/ErrorBox';
import type { LoginState } from '../routes/guards';

const EXPIRED_TEXT = 'Сессия истекла, войдите снова';

type ApiState = 'loading' | 'ok' | 'error';

export function LoginPage() {
  const { status, login } = useAuth();
  const location = useLocation();
  const state = (location.state ?? {}) as LoginState;
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [api, setApi] = useState<ApiState>('loading');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setApi(res.ok ? 'ok' : 'error'))
      .catch(() => setApi('error'));
  }, []);

  if (status === 'authed') return <Navigate to={safeReturnPath(state.from)} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(loginName, password);
    } catch (err) {
      setError(toProblem(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>Отпуска</h1>
      {/* при ошибке входа сообщение об истёкшей сессии не показывается (RULES §7-1) */}
      {error ? (
        <ErrorBox problem={error} />
      ) : (
        state.expired && (
          <p role="status" className="notice">
            {EXPIRED_TEXT}
          </p>
        )
      )}
      <form onSubmit={onSubmit}>
        <label>
          Логин
          <input
            name="login"
            autoComplete="username"
            value={loginName}
            onChange={(e) => setLoginName(e.target.value)}
          />
        </label>
        <label>
          Пароль
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          Войти
        </button>
      </form>
      <p data-testid="api-status" className="muted">
        API: {api === 'loading' ? 'проверка…' : api === 'ok' ? 'доступен' : 'недоступен'}
      </p>
    </main>
  );
}
