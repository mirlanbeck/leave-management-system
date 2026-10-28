import { useState } from 'react';
import type { HrBalanceRow } from '../api/types';
import { canSaveHireDate, HIRE_DATE_MAX, HIRE_DATE_MIN, HIRE_DATE_WARNING, isNewHireDate } from './hire-date-logic';

interface Props {
  row: HrBalanceRow;
  busy: boolean;
  onSubmit: (hireDate: string) => void;
  onClose: () => void;
}

/**
 * Форма смены даты выхода в строке «Остатков по сотрудникам» (RULES §6-1, §6-2; DECISIONS
 * 2026-10-28 19:19): предупреждение, как только введена новая дата; одна кнопка «Сохранить».
 */
export function HireDateForm({ row, busy, onSubmit, onClose }: Props) {
  const [hireDate, setHireDate] = useState('');
  const inputId = `hire-date-${row.employeeId}`;
  return (
    <div className="confirm" data-testid="hire-date-form">
      <label htmlFor={inputId}>Новая дата выхода</label>
      <input
        id={inputId}
        type="date"
        required
        min={HIRE_DATE_MIN}
        max={HIRE_DATE_MAX}
        value={hireDate}
        onChange={(e) => setHireDate(e.target.value)}
      />
      {isNewHireDate(hireDate, row.hireDate) && (
        <p role="alert" className="warning" data-testid="hire-date-warning">
          {HIRE_DATE_WARNING}
        </p>
      )}
      <div className="decision-buttons">
        <button
          type="button"
          disabled={busy || !canSaveHireDate(hireDate, row.hireDate)}
          onClick={() => onSubmit(hireDate)}
        >
          Сохранить
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}
