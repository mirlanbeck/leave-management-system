import { useEffect, useState } from 'react';

type ApiState = 'loading' | 'ok' | 'error';

export function App() {
  const [api, setApi] = useState<ApiState>('loading');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setApi(res.ok ? 'ok' : 'error'))
      .catch(() => setApi('error'));
  }, []);

  return (
    <main>
      <h1>Отпуска</h1>
      <p data-testid="api-status">
        API:{' '}
        {api === 'loading' ? 'проверка…' : api === 'ok' ? 'доступен' : 'недоступен'}
      </p>
    </main>
  );
}
