import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { describeProblem, toProblem, type ApiProblem } from '../api/problem';
import type { HrBalanceRow } from '../api/types';
import { oneAtATime } from '../approvals/approval-logic';
import { ErrorBox } from '../components/ErrorBox';
import { formatHireDate as formatDate, orEmpty } from '../profile/format';
import { latestOnly } from '../vacation/balance-logic';
import { formatDays, isNegativeDays } from '../vacation/format';
import { HIRE_DATE_CHANGED, hireDateBody } from './hire-date-logic';
import { HireDateForm } from './HireDateForm';

type Outcome = { tone: 'ok' | 'error'; text: string };

/**
 * «Остатки по сотрудникам» у HR (RULES §7-2): все сотрудники, остаток на сегодня, смена даты
 * выхода (§6-1). Сообщение после сохранения разовое: только в состоянии страницы (§6-3).
 * Отрицательный остаток с типографским минусом и цветом (§6-4).
 */
export function EmployeeBalances() {
  const [rows, setRows] = useState<HrBalanceRow[] | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const take = useMemo(() => latestOnly(), []);
  const guard = useMemo(() => oneAtATime(), []);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const isLatest = take();
    api
      .get<HrBalanceRow[]>('/hr/balances')
      .then((list) => {
        if (!isLatest()) return;
        setRows(list);
        setError(null);
      })
      .catch((e: unknown) => {
        if (isLatest()) setError(toProblem(e));
      });
  }, [reloadKey, take]);

  function open(id: number) {
    setOutcome(null); // сообщение §6-3 показывается один раз
    setOpenId(id);
  }

  // одна смена за раз, повторный клик запрос не шлёт (RULES §10-1)
  function save(row: HrBalanceRow, hireDate: string) {
    void guard(async () => {
      setBusy(true);
      try {
        await api.patch(`/employees/${row.employeeId}/hire-date`, hireDateBody(hireDate));
        setOutcome({ tone: 'ok', text: HIRE_DATE_CHANGED });
        setOpenId(null);
      } catch (e) {
        setOutcome({ tone: 'error', text: describeProblem(toProblem(e)) });
      } finally {
        setBusy(false);
        reload();
      }
    });
  }

  return (
    <section className="panel" aria-label="Остатки по сотрудникам">
      <h2>Остатки по сотрудникам</h2>
      {outcome && (
        <p role="status" data-testid="hr-balances-outcome" className={outcome.tone === 'ok' ? 'notice' : 'error'}>
          {outcome.text}
        </p>
      )}
      {rows === null && error === null && <p className="muted">Загрузка…</p>}
      {rows && rows.length > 0 && (
        <table className="requests">
          <thead>
            <tr>
              <th>Сотрудник</th>
              <th>Команда</th>
              <th>Руководитель</th>
              <th>Дата выхода</th>
              <th>Остаток на сегодня</th>
              <th>Действие</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.employeeId} data-testid="hr-balance-row">
                <td>{r.fullName}</td>
                <td>{orEmpty(r.teamName)}</td>
                <td>{orEmpty(r.manager?.fullName)}</td>
                <td data-testid="hr-balance-hire-date">{formatDate(r.hireDate)}</td>
                <td data-testid="hr-balance-days" className={isNegativeDays(r.balance) ? 'negative' : undefined}>
                  {formatDays(r.balance)}
                </td>
                <td>
                  {openId !== r.employeeId && (
                    <button type="button" disabled={busy} onClick={() => open(r.employeeId)}>
                      Изменить дату выхода
                    </button>
                  )}
                  {openId === r.employeeId && (
                    <HireDateForm
                      row={r}
                      busy={busy}
                      onSubmit={(date) => save(r, date)}
                      onClose={() => setOpenId(null)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && (
        <div data-testid="hr-balances-error">
          <ErrorBox problem={error} />
        </div>
      )}
    </section>
  );
}
