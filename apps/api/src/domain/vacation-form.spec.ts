import { checkVacationForm, VacationFormInput } from './vacation-form';

// Базовый случай: сегодня среда 2026-10-21, выход давно, период в будущем.
const base: VacationFormInput = {
  startDate: '2026-11-02',
  endDate: '2026-11-06',
  comment: null,
  today: '2026-10-21',
  hireDate: '2020-01-15',
};
const check = (patch: Partial<VacationFormInput>) =>
  checkVacationForm({ ...base, ...patch });

describe('checkVacationForm', () => {
  // RULES §3-4
  it('корректная заявка проходит', () => {
    expect(check({})).toBeNull();
  });

  // RULES §3-4 (проектная проверка порядка дат, architecture.md, раздел 8)
  it('начало позже конца', () => {
    expect(check({ startDate: '2026-11-05', endDate: '2026-11-03' })).toBe(
      'VACATION_DATES_ORDER',
    );
  });

  describe('одна заявка — в пределах одного года (п.1)', () => {
    // RULES §3-4
    it.each([
      ['2026-12-30', '2027-01-02', 'VACATION_CROSSES_YEAR'],
      ['2026-12-31', '2027-01-01', 'VACATION_CROSSES_YEAR'],
      ['2026-12-29', '2026-12-31', null], // заканчивается 31 декабря — можно
      ['2027-01-04', '2027-01-08', null], // начинается после 1 января — можно
      ['2027-01-01', '2027-01-01', null], // 1 января — пятница
    ])('%s..%s → %s', (startDate, endDate, expected) => {
      expect(check({ startDate, endDate })).toBe(expected);
    });
  });

  describe('минимум 1 рабочий день (п.2)', () => {
    // RULES §3-4
    it.each([
      ['2026-11-07', '2026-11-08', 'VACATION_NO_WORK_DAYS'], // сб–вс
      ['2026-11-07', '2026-11-07', 'VACATION_NO_WORK_DAYS'],
      ['2026-11-06', '2026-11-08', null], // пт–вс: один рабочий день
      ['2026-11-08', '2026-11-09', null], // вс–пн
    ])('%s..%s → %s', (startDate, endDate, expected) => {
      expect(check({ startDate, endDate })).toBe(expected);
    });
  });

  describe('до первого начисления', () => {
    // RULES §3-6 (Сотрудник 3: выход 12 октября, до 1 ноября нельзя)
    it.each([
      ['2026-10-12', '2026-10-21', 'NO_ACCRUAL_YET'],
      ['2026-10-12', '2026-10-31', 'NO_ACCRUAL_YET'],
      ['2026-10-12', '2026-11-01', null], // в день первого начисления уже можно
      ['2026-10-01', '2026-10-31', 'NO_ACCRUAL_YET'],
      ['2026-12-31', '2026-12-31', 'NO_ACCRUAL_YET'],
      ['2026-12-31', '2027-01-01', null], // начисление 0, но дата наступила: проверка остатка — S4
      ['2027-01-10', '2026-10-21', 'NO_ACCRUAL_YET'], // выход в будущем
    ])('выход %s, сегодня %s → %s', (hireDate, today, expected) => {
      expect(
        check({
          hireDate,
          today,
          startDate: '2027-02-01',
          endDate: '2027-02-05',
        }),
      ).toBe(expected);
    });
  });

  describe('«в прошлом»: начало раньше сегодня', () => {
    // RULES §3-7
    it.each([
      ['вчера, без комментария', '2026-10-20', null, 'PAST_COMMENT_REQUIRED'],
      ['вчера, с комментарием', '2026-10-20', 'забыл оформить', null],
      [
        'вчера, комментарий из пробелов',
        '2026-10-20',
        '   ',
        'PAST_COMMENT_REQUIRED',
      ],
      ['вчера, пустой комментарий', '2026-10-20', '', 'PAST_COMMENT_REQUIRED'],
      ['сегодня, без комментария', '2026-10-21', null, null], // не «в прошлом»
      ['завтра, без комментария', '2026-10-22', undefined, null],
      ['в текущем году (январь)', '2026-01-12', 'причина', null],
      [
        'в прошлом году, с комментарием',
        '2025-12-29',
        'причина',
        'PAST_START_YEAR',
      ],
      [
        'в прошлом году, без комментария',
        '2025-12-29',
        null,
        'PAST_START_YEAR',
      ],
    ])('%s', (_name, startDate, comment, expected) => {
      expect(
        check({
          startDate,
          endDate: startDate === '2025-12-29' ? '2025-12-30' : '2026-10-23',
          comment,
        }),
      ).toBe(expected);
    });

    // RULES §3-7
    it('первого января текущего года и 31 декабря прошлого', () => {
      expect(
        check({ startDate: '2026-01-01', endDate: '2026-01-02', comment: 'x' }),
      ).toBeNull();
      expect(
        check({ startDate: '2025-12-31', endDate: '2025-12-31', comment: 'x' }),
      ).toBe('PAST_START_YEAR');
    });

    // RULES §3-7 (1 января: начало 31 декабря прошлого года — уже прошлый год)
    it('сегодня 1 января: вчера — прошлый год', () => {
      expect(
        check({
          today: '2027-01-01',
          startDate: '2026-12-31',
          endDate: '2026-12-31',
          comment: 'x',
        }),
      ).toBe('PAST_START_YEAR');
    });
  });

  describe('порядок проверок', () => {
    // RULES §3-4 (architecture.md, раздел 8: даты → год → рабочие дни → до начисления → в прошлом)
    it('год раньше рабочих дней', () => {
      expect(check({ startDate: '2026-12-26', endDate: '2027-01-03' })).toBe(
        'VACATION_CROSSES_YEAR',
      );
    });

    it('рабочие дни раньше «в прошлом»', () => {
      expect(check({ startDate: '2026-10-17', endDate: '2026-10-18' })).toBe(
        'VACATION_NO_WORK_DAYS',
      ); // RULES §3-4
    });

    it('«до начисления» раньше «в прошлом»', () => {
      expect(
        check({
          hireDate: '2026-10-12',
          startDate: '2026-10-19',
          endDate: '2026-10-20',
        }),
      ).toBe(
        'NO_ACCRUAL_YET', // RULES §3-6
      );
    });
  });
});
