import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toProblem, type ApiProblem } from '../api/problem';
import type { Balance } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { formatHireDate as formatDate } from '../profile/format';
import { balancePath, latestOnly } from './balance-logic';
import { formatDays, isNegativeDays } from './format';

function Days({ value, testId }: { value: number; testId: string }) {
  return (
    <strong data-testid={testId} className={isNegativeDays(value) ? 'negative' : undefined}>
      {formatDays(value)}
    </strong>
  );
}

/**
 * Единственное место, где сотрудник видит свой остаток: «сегодня» и «доступно на дату»
 * (RULES §3-10; DECISIONS 2026-10-22 12:15, 2026-10-26 00:43). Оба числа и «сегодня» даёт сервер.
 */
export function BalancePanel(props: { on: string; onChangeOn: (on: string) => void }) {
  const { on, onChangeOn } = props;
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const take = useMemo(() => latestOnly(), []);

  useEffect(() => {
    const isLatest = take();
    api
      .get<Balance>(balancePath(on))
      .then((b) => {
        if (!isLatest()) return;
        setBalance(b);
        setError(null);
      })
      .catch((e: unknown) => {
        if (isLatest()) setError(toProblem(e));
      });
  }, [on, take]);

  return (
    <section className="panel" aria-label="Остаток дней">
      <h2>Остаток дней</h2>
      {balance === null && error === null && <p className="muted">Загрузка…</p>}
      {balance && (
        <dl>
          <dt>
            Доступно сегодня (<span data-testid="balance-today-date">{formatDate(balance.today)}</span>)
          </dt>
          <dd>
            <Days value={balance.balance} testId="balance-today" />
          </dd>
          <dt>
            <label>
              Доступно на дату
              <input type="date" value={on} onChange={(e) => onChangeOn(e.target.value)} />
            </label>
          </dt>
          <dd>
            {on !== '' && balance.on === on && balance.availableOn !== null ? (
              <Days value={balance.availableOn} testId="balance-on" />
            ) : (
              <span className="muted">выберите дату</span>
            )}
          </dd>
        </dl>
      )}
      {error && (
        <div data-testid="balance-error">
          <ErrorBox problem={error} />
        </div>
      )}
    </section>
  );
}
