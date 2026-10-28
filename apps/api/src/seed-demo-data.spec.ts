import { compareDates, countWorkDays, isoWeekday, yearOf } from './domain';
import {
  DEMO_SCENARIOS,
  demoBaseMonday,
  demoPeriods,
  type DemoPeriod,
} from './seed-demo-data';
import { SEED_USERS } from './seed-data';

const overlap = (a: DemoPeriod, b: DemoPeriod) =>
  compareDates(a.startDate, b.endDate) <= 0 &&
  compareDates(b.startDate, a.endDate) <= 0;

describe('данные seed:demo', () => {
  const byAuthor = (today: string) =>
    new Map(demoPeriods(today).map((p) => [p.scenario.author, p]));

  // RULES §9-1: даты от «сегодня» по Clock
  it('M — первый понедельник не раньше сегодня + 14 дней', () => {
    expect(demoBaseMonday('2026-10-21')).toBe('2026-11-09');
    expect(demoBaseMonday('2026-10-26')).toBe('2026-11-09'); // пн + 14 = пн
    expect(demoBaseMonday('2026-10-27')).toBe('2026-11-16');
  });

  // RULES §9-1: при часах 2026-10-21 даты из описания issue
  it('периоды при сегодня 2026-10-21', () => {
    const p = byAuthor('2026-10-21');
    const span = (l: string) => [p.get(l)!.startDate, p.get(l)!.endDate];
    expect(span('margaret')).toEqual(['2026-11-09', '2026-11-13']);
    expect(span('emily')).toEqual(['2026-11-16', '2026-11-20']);
    expect(span('james')).toEqual(['2026-11-09', '2026-11-13']);
    expect(span('sophie')).toEqual(['2026-11-11', '2026-11-17']);
    expect(span('grace')).toEqual(['2026-11-16', '2026-11-20']);
    expect(span('henry')).toEqual(['2026-11-23', '2026-11-27']);
    expect(span('chloe')).toEqual(['2026-11-16', '2026-11-20']);
  });

  // RULES §3-4 п.2: в каждом периоде 5 рабочих дней, начало в будущем
  it.each(['2026-10-21', '2026-12-01', '2027-02-26'])(
    'по 5 рабочих дней, начало позже сегодня (%s)',
    (today) => {
      for (const p of demoPeriods(today)) {
        expect(countWorkDays(p.startDate, p.endDate)).toBe(5);
        expect(compareDates(p.startDate, today)).toBeGreaterThan(0);
      }
    },
  );

  // RULES §3-4 п.1: заявка в пределах одного года
  it('самый поздний период через Новый год: все периоды в январе', () => {
    // M = 2026-12-14, M+18 = 2027-01-01 → перенос на первый понедельник 2027
    expect(demoBaseMonday('2026-11-30')).toBe('2027-01-04');
    for (const p of demoPeriods('2026-11-30')) {
      expect(yearOf(p.startDate)).toBe(2027);
      expect(yearOf(p.endDate)).toBe(2027);
    }
    // M = 2026-12-07, M+18 = 2026-12-25: переноса нет
    expect(demoBaseMonday('2026-11-23')).toBe('2026-12-07');
  });

  // RULES §3-4 п.1: и в самом позднем сценарии год не пересекается
  it.each(['2026-11-16', '2026-11-30', '2026-12-10', '2026-12-31'])(
    'ни один период не пересекает год (%s)',
    (today) => {
      expect(isoWeekday(demoBaseMonday(today))).toBe(1);
      for (const p of demoPeriods(today)) {
        expect(yearOf(p.startDate)).toBe(yearOf(p.endDate));
      }
    },
  );

  // RULES §4-6: пересечение только у james и sophie, grace свободна от henry
  it('james и sophie пересекаются, grace с henry — нет', () => {
    const p = byAuthor('2026-10-21');
    expect(overlap(p.get('james')!, p.get('sophie')!)).toBe(true);
    expect(overlap(p.get('grace')!, p.get('henry')!)).toBe(false);
  });

  // RULES §4-1, §4-2, §4-4: итоговые статусы сценариев
  it('решения: james и henry одобряют, chloe отклоняют, остальные ждут', () => {
    const decisions = Object.fromEntries(
      DEMO_SCENARIOS.map((s) => [s.author, s.decision?.kind ?? null]),
    );
    expect(decisions).toEqual({
      margaret: null,
      emily: null,
      james: 'approve',
      sophie: null,
      grace: null,
      henry: 'approve',
      chloe: 'reject',
    });
  });

  // RULES §4-1, §4-2: решает непосредственный руководитель, по директору — HR
  it('решение принимает согласующий автора', () => {
    const users = new Map(SEED_USERS.map((u) => [u.login, u]));
    for (const s of DEMO_SCENARIOS) {
      if (!s.decision) continue;
      expect(s.decision.by).toBe(users.get(s.author)!.managerLogin);
    }
  });

  // RULES §3-3: backstopper — другой сотрудник компании
  it('backstopper существует и не совпадает с автором', () => {
    const logins = new Set(SEED_USERS.map((u) => u.login));
    for (const s of DEMO_SCENARIOS) {
      expect(logins.has(s.author)).toBe(true);
      expect(logins.has(s.backstopper)).toBe(true);
      expect(s.backstopper).not.toBe(s.author);
    }
  });

  // RULES §3-6, §7-5: у Сотрудника 3 заявок нет, у остальных по одной
  it('у liam сценариев нет, у каждого автора один сценарий', () => {
    const authors = DEMO_SCENARIOS.map((s) => s.author);
    expect(authors).not.toContain('liam');
    expect(new Set(authors).size).toBe(authors.length);
  });
});
