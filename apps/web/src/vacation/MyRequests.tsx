import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toProblem, type ApiProblem } from '../api/problem';
import type { Vacation } from '../api/types';
import { decideThenReload, oneAtATime, type DecisionOutcome } from '../approvals/approval-logic';
import { ErrorBox } from '../components/ErrorBox';
import { formatHireDate as formatDate } from '../profile/format';
import { latestOnly } from './balance-logic';
import { canCancel, cancelConfirmText, cancelSuccessText } from './cancel-logic';
import { statusWithMarks } from './status';
import { canTransfer, transferSuccessText } from './transfer-logic';
import { TransferForm } from './TransferForm';

interface Props {
  reloadKey: number;
  /**
   * Есть - в строках «Отменить» (RULES §5-4) и «Перенести» (§5-2); после отмены или переноса
   * вызывается, чтобы страница перечитала список и остаток. Нет - список только для чтения
   * (раздел HR на «Согласовании», DECISIONS [S5], 2026-10-28 16:17).
   */
  onChanged?: () => void;
}

/** Что открыто в строке: подтверждение отмены или форма переноса (одно за раз). */
type Open = { id: number; kind: 'cancel' | 'transfer' } | null;

/**
 * Заявки вошедшего: даты, рабочие дни, статус по-русски с пометками переноса (RULES §3-11).
 * Порядок как у сервера, новые первыми (DECISIONS 2026-10-26 10:47). Смена reloadKey перечитывает список.
 */
export function MyRequests({ reloadKey, onChanged }: Props) {
  const [items, setItems] = useState<Vacation[] | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null);
  const take = useMemo(() => latestOnly(), []);
  const guard = useMemo(() => oneAtATime(), []);

  useEffect(() => {
    const isLatest = take();
    api
      .get<Vacation[]>('/vacations?scope=mine')
      .then((list) => {
        if (!isLatest()) return;
        setItems(list);
        setError(null);
      })
      .catch((e: unknown) => {
        if (isLatest()) setError(toProblem(e));
      });
  }, [reloadKey, take]);

  // одна отмена за раз, повторный клик запрос не шлёт (RULES §10-1)
  function cancel(v: Vacation) {
    if (!onChanged) return;
    void guard(async () => {
      setBusy(true);
      try {
        const result = await decideThenReload(
          () => api.post(`/vacations/${v.id}/cancel`, {}),
          onChanged,
          cancelSuccessText(v),
        );
        setOutcome(result);
        setOpen(null);
      } finally {
        setBusy(false);
      }
    });
  }

  // перенос подан: итог над таблицей, форма закрывается, список и остаток перечитываются
  function transferred(created: Vacation) {
    setOutcome({ tone: 'ok', text: transferSuccessText(created) });
    setOpen(null);
    onChanged?.();
  }

  const withActions = onChanged !== undefined;
  const isOpen = (v: Vacation, kind: 'cancel' | 'transfer') => open?.id === v.id && open.kind === kind;

  return (
    <section className="panel" aria-label="Мои заявки">
      <h2>Мои заявки</h2>
      {outcome && (
        <p role="status" data-testid="requests-outcome" className={outcome.tone === 'ok' ? 'notice' : 'error'}>
          {outcome.text}
        </p>
      )}
      {items === null && error === null && <p className="muted">Загрузка…</p>}
      {items?.length === 0 && (
        <p className="muted" data-testid="my-requests-empty">
          Заявок пока нет
        </p>
      )}
      {items && items.length > 0 && (
        <table className="requests">
          <thead>
            <tr>
              <th>Начало</th>
              <th>Окончание</th>
              <th>Рабочие дни</th>
              <th>Статус</th>
              {withActions && <th>Действие</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id} data-testid="my-request-row">
                <td>{formatDate(v.startDate)}</td>
                <td>{formatDate(v.endDate)}</td>
                <td>{v.workDays}</td>
                <td data-testid="my-request-status">{statusWithMarks(v)}</td>
                {withActions && (
                  <td>
                    {open?.id !== v.id && (
                      <div className="decision-buttons">
                        {canCancel(v) && (
                          <button type="button" disabled={busy} onClick={() => setOpen({ id: v.id, kind: 'cancel' })}>
                            Отменить
                          </button>
                        )}
                        {canTransfer(v) && (
                          <button type="button" disabled={busy} onClick={() => setOpen({ id: v.id, kind: 'transfer' })}>
                            Перенести
                          </button>
                        )}
                      </div>
                    )}
                    {canCancel(v) && isOpen(v, 'cancel') && (
                      <div className="confirm" data-testid="cancel-confirm">
                        <span>{cancelConfirmText(v)}</span>
                        <div className="decision-buttons">
                          <button type="button" disabled={busy} onClick={() => cancel(v)}>
                            Да, отменить
                          </button>
                          <button type="button" disabled={busy} onClick={() => setOpen(null)}>
                            Не отменять
                          </button>
                        </div>
                      </div>
                    )}
                    {canTransfer(v) && isOpen(v, 'transfer') && (
                      <TransferForm vacation={v} onTransferred={transferred} onClose={() => setOpen(null)} />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && (
        <div data-testid="requests-error">
          <ErrorBox problem={error} />
        </div>
      )}
    </section>
  );
}
