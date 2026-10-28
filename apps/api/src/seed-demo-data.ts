// Сценарии seed:demo (ROADMAP S5, issue S5-c): демо-заявки для проверки согласования.
// Даты считаются от «сегодня» по Clock; заявки подаются и решаются обычными сервисами.
import { addDays, isoWeekday, yearOf, type CalendarDate } from './domain';

/** Метка в комментарии заявки: по ней повторный запуск узнаёт свой сценарий. */
export const DEMO_MARKER = 'Демо-заявка (seed:demo)';

export interface DemoDecision {
  /** Логин согласующего: непосредственный руководитель, для директора — HR. */
  by: string;
  kind: 'approve' | 'reject';
  comment: string | null;
}

export interface DemoScenario {
  author: string;
  backstopper: string;
  /** Сдвиг начала и конца в днях от понедельника M. */
  from: number;
  to: number;
  decision: DemoDecision | null;
}

export interface DemoPeriod {
  scenario: DemoScenario;
  startDate: CalendarDate;
  endDate: CalendarDate;
}

/** Сценарии выполняются по порядку; у liam заявок нет: до 1 ноября подать нельзя (RULES §3-6). */
export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  // «допуск HR»: заявку директора согласует HR (RULES §4-2)
  { author: 'margaret', backstopper: 'thomas', from: 0, to: 4, decision: null },
  // заявку HR согласует заместитель директора (RULES §4-1)
  { author: 'emily', backstopper: 'daniel', from: 7, to: 11, decision: null },
  {
    author: 'james',
    backstopper: 'sophie',
    from: 0,
    to: 4,
    decision: { by: 'daniel', kind: 'approve', comment: null },
  },
  // пересекается с одобренным отпуском james: предупреждение у daniel (RULES §4-6)
  { author: 'sophie', backstopper: 'liam', from: 2, to: 8, decision: null },
  { author: 'grace', backstopper: 'henry', from: 7, to: 11, decision: null },
  {
    author: 'henry',
    backstopper: 'grace',
    from: 14,
    to: 18,
    decision: { by: 'olivia', kind: 'approve', comment: null },
  },
  {
    author: 'chloe',
    backstopper: 'grace',
    from: 7,
    to: 11,
    decision: {
      by: 'olivia',
      kind: 'reject',
      comment: 'Пересекается с релизом команды',
    },
  },
];

const LAST_OFFSET = Math.max(...DEMO_SCENARIOS.map((s) => s.to));

function mondayOnOrAfter(date: CalendarDate): CalendarDate {
  let d = date;
  while (isoWeekday(d) !== 1) d = addDays(d, 1);
  return d;
}

/**
 * M: первый понедельник не раньше сегодня + 14 дней. Если самый поздний период пересекает
 * 31 декабря, все периоды переносятся на первый понедельник января (RULES §3-4 п.1).
 */
export function demoBaseMonday(today: CalendarDate): CalendarDate {
  const m = mondayOnOrAfter(addDays(today, 14));
  if (yearOf(addDays(m, LAST_OFFSET)) === yearOf(m)) return m;
  return mondayOnOrAfter(`${yearOf(m) + 1}-01-01`);
}

export function demoPeriods(today: CalendarDate): DemoPeriod[] {
  const m = demoBaseMonday(today);
  return DEMO_SCENARIOS.map((scenario) => ({
    scenario,
    startDate: addDays(m, scenario.from),
    endDate: addDays(m, scenario.to),
  }));
}
