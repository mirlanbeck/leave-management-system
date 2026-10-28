import { useState } from 'react';
import { BalancePanel } from '../vacation/BalancePanel';
import { nextOnDate } from '../vacation/balance-logic';
import { MyRequests } from '../vacation/MyRequests';
import type { VacationFormValues } from '../vacation/submit-logic';
import { EMPTY_FORM, VacationForm } from '../vacation/VacationForm';

/** Страница «Отпуск»: остаток, форма заявки и «Мои заявки» (RULES §3; DECISIONS 2026-10-26 00:43). */
export function VacationPage() {
  const [form, setForm] = useState<VacationFormValues>(EMPTY_FORM);
  const [on, setOn] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  function changeForm(next: VacationFormValues) {
    // дата панели по умолчанию из начала заявки (RULES §3-10)
    setOn((current) => nextOnDate(form.startDate, next.startDate, current));
    setForm(next);
  }

  function submitted() {
    setForm(EMPTY_FORM);
    setReloadKey((k) => k + 1); // «Мои заявки» перечитываются после подачи
  }

  // после отмены перечитываются «Мои заявки» и остаток (RULES §5-4)
  const cancelled = () => setReloadKey((k) => k + 1);

  return (
    <section>
      <h1>Отпуск</h1>
      <BalancePanel on={on} onChangeOn={setOn} reloadKey={reloadKey} />
      <VacationForm values={form} onChange={changeForm} onSubmitted={submitted} />
      <MyRequests reloadKey={reloadKey} onCancelled={cancelled} />
    </section>
  );
}
