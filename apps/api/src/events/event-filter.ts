import { calendarScope, canSee, type OrgUser } from '../org/policy';
import type { DomainEvent } from './event-bus';

/**
 * Кому доставить событие SSE (RULES §7-2, §10-2). Чистая функция поверх `calendarScope`/`canSee`:
 * зритель и структура берутся из `org`, прочитанной на это событие, а не из токена.
 * - `vacation.*` - тем, у кого сотрудник в календаре (`calendarScope`);
 * - `employee.hire-date-changed` - тем, кому виден остаток (`canSee`): сам, руководитель, HR;
 * - `clock.changed` - всем вошедшим (демо-часы видны любому, RULES §9-3).
 */
export function deliver(
  event: DomainEvent,
  viewerId: number,
  org: readonly OrgUser[],
): boolean {
  const viewer = org.find((u) => u.id === viewerId);
  if (!viewer) return false;
  if (event.type === 'clock.changed') return true;

  const reportsOf = (managerId: number) =>
    org.filter((u) => u.managerId === managerId).map((u) => u.id);
  const reports = reportsOf(viewer.id);

  if (event.type === 'employee.hire-date-changed') {
    return canSee(viewer, reports, event.employeeId);
  }
  const peers = viewer.managerId === null ? [] : reportsOf(viewer.managerId);
  const s = calendarScope(viewer, reports, peers);
  return s === 'ALL' || s.has(event.employeeId);
}
