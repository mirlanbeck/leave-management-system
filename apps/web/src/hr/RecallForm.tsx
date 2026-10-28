import { useState } from 'react';
import type { Vacation } from '../api/types';
import { canSubmitRecall, recallHint } from './hr-logic';

interface Props {
  vacation: Vacation;
  busy: boolean;
  onSubmit: (returnDate: string) => void;
  onClose: () => void;
}

/**
 * Форма отзыва в строке «Все заявки» (RULES §5-5, §5-11; DECISIONS 2026-10-28 15:41): дата
 * выхода обязательна, от начала до окончания отпуска; отправка - «Подтвердить отзыв».
 */
export function RecallForm({ vacation, busy, onSubmit, onClose }: Props) {
  const [returnDate, setReturnDate] = useState('');
  const inputId = `recall-date-${vacation.id}`;
  return (
    <div className="confirm" data-testid="recall-form">
      <label htmlFor={inputId}>Дата выхода</label>
      <input
        id={inputId}
        type="date"
        required
        min={vacation.startDate}
        max={vacation.endDate}
        value={returnDate}
        onChange={(e) => setReturnDate(e.target.value)}
      />
      <span className="muted">{recallHint(vacation.endDate)}</span>
      <div className="decision-buttons">
        <button
          type="button"
          disabled={busy || !canSubmitRecall(returnDate, vacation)}
          onClick={() => onSubmit(returnDate)}
        >
          Подтвердить отзыв
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}
