import { ApprovalQueue } from '../approvals/ApprovalQueue';
import { useAuth } from '../auth/AuthContext';
import { MyRequests } from '../vacation/MyRequests';

/**
 * Страница «Согласование» (RULES §4-7; DECISIONS [S5]). У HR два раздела: «Мои заявки»
 * (только чтение; подача на странице «Отпуск») и «Допуск HR» — заявки директора (RULES §4-2).
 */
export function ApprovalsPage() {
  const { profile } = useAuth();
  return (
    <section>
      <h1>Согласование</h1>
      {profile?.isHr ? (
        <>
          <MyRequests reloadKey={0} />
          <ApprovalQueue title="Допуск HR" />
        </>
      ) : (
        <ApprovalQueue />
      )}
    </section>
  );
}
