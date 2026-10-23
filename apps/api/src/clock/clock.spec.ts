import { FakeClock, SystemClock } from './clock';
import { DEFAULT_COMPANY_TZ, companyToday, companyTz } from './company-tz';

describe('Clock', () => {
  // RULES §9
  it('FakeClock возвращает заданный момент и не идёт сам', () => {
    const clock = new FakeClock('2026-10-21T03:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-10-21T03:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-10-21T03:00:00.000Z');
  });

  // RULES §9
  it('FakeClock переставляется вперёд и назад', () => {
    const clock = new FakeClock('2026-10-21T03:00:00Z');
    clock.advanceMs(60_000);
    expect(clock.now().toISOString()).toBe('2026-10-21T03:01:00.000Z');
    clock.set('2026-01-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  // RULES §9
  it('SystemClock возвращает текущий момент', () => {
    const before = Date.now();
    const value = new SystemClock().now().getTime();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });
});

describe('companyToday', () => {
  // RULES §1
  it('граница: 2026-12-31T18:00Z — уже 1 января в Бишкеке', () => {
    const clock = new FakeClock('2026-12-31T18:00:00Z');
    expect(companyToday(clock, 'Asia/Bishkek')).toBe('2027-01-01');
  });

  // RULES §1
  it('за минуту до границы — ещё 31 декабря', () => {
    const clock = new FakeClock('2026-12-31T17:59:00Z');
    expect(companyToday(clock, 'Asia/Bishkek')).toBe('2026-12-31');
  });

  // RULES §1
  it('не зависит от TZ процесса', () => {
    const clock = new FakeClock('2026-12-31T18:00:00Z');
    expect(companyToday(clock, 'Asia/Bishkek')).toBe('2027-01-01');
    expect(companyToday(clock, 'America/New_York')).toBe('2026-12-31');
  });

  // RULES §1
  it('пояс по умолчанию Asia/Bishkek, переопределяется COMPANY_TZ', () => {
    expect(companyTz({})).toBe(DEFAULT_COMPANY_TZ);
    expect(DEFAULT_COMPANY_TZ).toBe('Asia/Bishkek');
    expect(companyTz({ COMPANY_TZ: 'UTC' })).toBe('UTC');
  });
});
