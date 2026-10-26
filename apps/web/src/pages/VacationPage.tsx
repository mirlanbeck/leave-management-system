import { useState } from 'react';
import { BalancePanel } from '../vacation/BalancePanel';
import { nextOnDate } from '../vacation/balance-logic';
import type { VacationFormValues } from '../vacation/submit-logic';
import { EMPTY_FORM, VacationForm } from '../vacation/VacationForm';

/** Страница «Отпуск»: остаток и форма заявки (RULES §3; DECISIONS 2026-10-26 00:43). */
export function VacationPage() {
  const [form, setForm] = useState<VacationFormValues>(EMPTY_FORM);
  const [on, setOn] = useState('');

  function changeForm(next: VacationFormValues) {
    // дата панели по умолчанию из начала заявки (RULES §3-10)
    setOn((current) => nextOnDate(form.startDate, next.startDate, current));
    setForm(next);
  }

  return (
    <section>
      <h1>Отпуск</h1>
      <BalancePanel on={on} onChangeOn={setOn} />
      <VacationForm values={form} onChange={changeForm} onSubmitted={() => setForm(EMPTY_FORM)} />
    </section>
  );
}
