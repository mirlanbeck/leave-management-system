import { companyLocalToInstant } from './company-time';

describe('companyLocalToInstant', () => {
  // RULES §9-3
  it('Бишкек (UTC+6): 09:00 -> 03:00 UTC', () => {
    expect(
      companyLocalToInstant(
        '2026-10-21',
        '09:00',
        'Asia/Bishkek',
      )?.toISOString(),
    ).toBe('2026-10-21T03:00:00.000Z');
  });

  // RULES §9-3
  it('несуществующая дата -> null', () => {
    expect(
      companyLocalToInstant('2026-02-30', '09:00', 'Asia/Bishkek'),
    ).toBeNull();
    expect(
      companyLocalToInstant('2026-13-01', '09:00', 'Asia/Bishkek'),
    ).toBeNull();
  });

  // RULES §9-3
  it('несуществующее время: пропуск при переходе на летнее время -> null', () => {
    expect(
      companyLocalToInstant('2026-03-08', '02:30', 'America/New_York'),
    ).toBeNull();
  });

  // RULES §9-3
  it('обычное время в New_York', () => {
    expect(
      companyLocalToInstant(
        '2026-03-08',
        '03:30',
        'America/New_York',
      )?.toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
  });

  // RULES §9-3
  it('неоднозначное время при обратном переходе: берётся более раннее', () => {
    expect(
      companyLocalToInstant(
        '2026-11-01',
        '01:30',
        'America/New_York',
      )?.toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
  });

  // RULES §9-3, §1-3
  it('не зависит от TZ процесса', () => {
    expect(
      companyLocalToInstant(
        '2027-01-01',
        '00:00',
        'Asia/Bishkek',
      )?.toISOString(),
    ).toBe('2026-12-31T18:00:00.000Z');
  });
});
