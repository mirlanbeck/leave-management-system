import { AllRequests } from '../hr/AllRequests';
import { EmployeeBalances } from '../hr/EmployeeBalances';

/**
 * Экран HR (RULES §7-2; DECISIONS 2026-10-28 15:41, 2026-10-28 19:19): «Все заявки» с отзывом (S6a)
 * и «Остатки по сотрудникам» со сменой даты выхода (S6c).
 */
export function HrPage() {
  return (
    <section>
      <h1>Экран HR</h1>
      <AllRequests />
      <EmployeeBalances />
    </section>
  );
}
