import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toProblem, type ApiProblem } from '../api/problem';
import type { ApprovalItem } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { latestOnly } from '../vacation/balance-logic';
import { ApprovalCard } from './ApprovalCard';
import type { DecisionOutcome } from './approval-logic';

/**
 * Очередь согласующего (GET /approvals, RULES §4-7): у руководителя заявки прямых подчинённых,
 * у HR заявки директора («Допуск HR», §4-2). Порядок как у сервера, старые сверху.
 * Итог решения — одной строкой над списком, список после решения перечитывается (DECISIONS [S5]).
 */
export function ApprovalQueue({ title }: { title?: string }) {
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const take = useMemo(() => latestOnly(), []);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const isLatest = take();
    api
      .get<ApprovalItem[]>('/approvals')
      .then((list) => {
        if (!isLatest()) return;
        setItems(list);
        setError(null);
      })
      .catch((e: unknown) => {
        if (isLatest()) setError(toProblem(e));
      });
  }, [reloadKey, take]);

  return (
    <section aria-label={title ?? 'Заявки на согласование'}>
      {title && <h2>{title}</h2>}
      {outcome && (
        <p role="status" data-testid="approvals-outcome" className={outcome.tone === 'ok' ? 'notice' : 'error'}>
          {outcome.text}
        </p>
      )}
      {items === null && error === null && <p className="muted">Загрузка…</p>}
      {items?.length === 0 && (
        <p className="muted" data-testid="approvals-empty">
          Заявок на согласование нет
        </p>
      )}
      {items?.map((item) => (
        <ApprovalCard key={item.vacation.id} item={item} onReload={reload} onOutcome={setOutcome} />
      ))}
      {error && (
        <div data-testid="approvals-error">
          <ErrorBox problem={error} />
        </div>
      )}
    </section>
  );
}
