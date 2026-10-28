import type { CalendarBalance } from '../api/types';
import { formatHireDate as formatDate } from '../profile/format';
import { formatDays, isNegativeDays } from '../vacation/format';

/**
 * Остатки прямых подчинённых на сегодня (RULES §7-2): только у руководителя. Дни через запятую,
 * отрицательный остаток с типографским минусом и цветом (RULES §2-7, §6-4).
 */
export function TeamBalances({ balances, today }: { balances: CalendarBalance[]; today: string }) {
  return (
    <section className="panel" aria-label="Остатки команды">
      <h2>Остатки команды на {formatDate(today)}</h2>
      <table className="requests">
        <tbody>
          {balances.map((b) => (
            <tr key={b.employee.id} data-testid="team-balance">
              <td>{b.employee.fullName}</td>
              <td className={isNegativeDays(b.balance) ? 'negative' : undefined}>{formatDays(b.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
