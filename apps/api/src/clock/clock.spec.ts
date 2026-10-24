import { FakeClock, SystemClock } from './clock';
import { DEFAULT_COMPANY_TZ, companyToday, companyTz } from './company-tz';

describe('Clock', () => {
  // RULES §9-1
  it('FakeClock возвращает заданный момент и не идёт сам', async () => {
    const clock = new FakeClock('2026-10-21T03:00:00Z');
    expect((await clock.now()).toISOString()).toBe('2026-10-21T03:00:00.000Z');
    expect((await clock.now()).toISOString()).toBe('2026-10-21T03:00:00.000Z');
  });

  // RULES §9-1
  it('FakeClock переставляется вперёд и назад', async () => {
    const clock = new FakeClock('2026-10-21T03:00:00Z');
    clock.advanceMs(60_000);
    expect((await clock.now()).toISOString()).toBe('2026-10-21T03:01:00.000Z');
    clock.set('2026-01-01T00:00:00Z');
    expect((await clock.now()).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  // RULES §9-1
  it('SystemClock возвращает текущий момент', async () => {
    const before = Date.now();
    const value = (await new SystemClock().now()).getTime();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });
});

describe('companyToday', () => {
  // RULES §1-3
  it('граница: 2026-12-31T18:00Z — уже 1 января в Бишкеке', () => {
    const now = new Date('2026-12-31T18:00:00Z');
    expect(companyToday(now, 'Asia/Bishkek')).toBe('2027-01-01');
  });

  // RULES §1-3
  it('за минуту до границы — ещё 31 декабря', () => {
    const now = new Date('2026-12-31T17:59:00Z');
    expect(companyToday(now, 'Asia/Bishkek')).toBe('2026-12-31');
  });

  // RULES §1-3
  it('не зависит от TZ процесса', () => {
    const now = new Date('2026-12-31T18:00:00Z');
    expect(companyToday(now, 'Asia/Bishkek')).toBe('2027-01-01');
    expect(companyToday(now, 'America/New_York')).toBe('2026-12-31');
  });

  // RULES §1-3
  it('пояс по умолчанию Asia/Bishkek, переопределяется COMPANY_TZ', () => {
    expect(companyTz({})).toBe(DEFAULT_COMPANY_TZ);
    expect(DEFAULT_COMPANY_TZ).toBe('Asia/Bishkek');
    expect(companyTz({ COMPANY_TZ: 'UTC' })).toBe('UTC');
  });
});
