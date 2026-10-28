import { AllRequests } from '../hr/AllRequests';

/**
 * Экран HR (RULES §7-2; DECISIONS 2026-10-28 15:41). S6a: «Все заявки» с отзывом;
 * «Остатки по сотрудникам» и смена даты выхода добавятся в S6c.
 */
export function HrPage() {
  return (
    <section>
      <h1>Экран HR</h1>
      <AllRequests />
    </section>
  );
}
