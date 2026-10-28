import { useMemo, useState } from 'react';
import { api } from '../api';
import type { ApprovalItem } from '../api/types';
import { orEmpty } from '../profile/format';
import {
  availableText,
  decideThenReload,
  decisionBody,
  decisionButtons,
  oneAtATime,
  overlapText,
  periodText,
  successText,
  transferLabel,
  type DecisionKind,
  type DecisionOutcome,
} from './approval-logic';

interface Props {
  item: ApprovalItem;
  onReload: () => void;
  onOutcome: (outcome: DecisionOutcome) => void;
}

/**
 * Заявка в очереди согласующего (RULES §4-7): сотрудник, даты, рабочие дни, backstopper,
 * комментарий, остаток на дату начала, предупреждение о пересечениях (§4-6); решение (§4-1, §4-3).
 */
export function ApprovalCard({ item, onReload, onOutcome }: Props) {
  const v = item.vacation;
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useMemo(() => oneAtATime(), []);
  const buttons = decisionButtons(item, busy);
  const available = availableText(item.availableOnStart);
  const overlaps = overlapText(item.overlaps);
  const transfer = transferLabel(v);
  const commentId = `decision-comment-${v.id}`;

  function decide(kind: DecisionKind) {
    void guard(async () => {
      setBusy(true);
      try {
        const outcome = await decideThenReload(
          () => api.post(`/vacations/${v.id}/${kind}`, decisionBody(comment)),
          onReload,
          successText(kind, v.employee.fullName),
        );
        onOutcome(outcome);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <article className="panel approval" data-testid="approval-card" aria-label={`Заявка ${v.employee.fullName}`}>
      {transfer && (
        <p className="notice" data-testid="approval-transfer">
          {transfer}
        </p>
      )}
      <dl>
        <dt>Сотрудник</dt>
        <dd data-testid="approval-employee">{v.employee.fullName}</dd>
        <dt>Даты</dt>
        <dd data-testid="approval-period">{periodText(v.startDate, v.endDate)}</dd>
        <dt>Рабочие дни</dt>
        <dd data-testid="approval-workdays">{v.workDays}</dd>
        <dt>Заменяющий (backstopper)</dt>
        <dd data-testid="approval-backstopper">{v.backstopper.fullName}</dd>
        <dt>Комментарий</dt>
        <dd data-testid="approval-comment">{orEmpty(v.comment)}</dd>
        <dt>Доступно на дату начала</dt>
        <dd>
          <strong data-testid="approval-available" className={available.negative ? 'negative' : undefined}>
            {available.text}
          </strong>
        </dd>
      </dl>
      {overlaps && (
        <p className="notice" data-testid="approval-overlaps">
          {overlaps}
        </p>
      )}
      {buttons.reason && (
        <p className="error" data-testid="approval-block-reason">
          {buttons.reason}
        </p>
      )}
      {(buttons.approveVisible || buttons.rejectVisible) && (
        <div className="decision">
          <label htmlFor={commentId}>Комментарий к решению (необязательно)</label>
          <textarea id={commentId} value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
          <div className="decision-buttons">
            {buttons.approveVisible && (
              <button type="button" disabled={!buttons.approveEnabled} onClick={() => decide('approve')}>
                Подтвердить
              </button>
            )}
            {buttons.rejectVisible && (
              <button type="button" disabled={!buttons.rejectEnabled} onClick={() => decide('reject')}>
                Отклонить
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
