import type { BalanceInput, LedgerAction } from '../domain';
import { VacationStatus } from '../generated/prisma/enums';
import {
  evaluateSubmission,
  evaluateTransfer,
  formatDays,
  transferSourceError,
  type SubmissionInput,
  type TransferInput,
  type TransferSourceFacts,
} from './vacation-rules';

// Базовый случай: сегодня среда 2026-10-21, выход давно (остаток 37,5, на 2026-11-02 уже 40),
// период пн–пт 2026-11-02…06, backstopper существует, других заявок нет.
const EMPLOYEE = 10;
const balance = (patch: Partial<BalanceInput> = {}): BalanceInput => ({
  hireDate: '2020-01-15',
  ledger: [],
  today: '2026-10-21',
  tz: 'Asia/Bishkek',
  ...patch,
});
const base: SubmissionInput = {
  employeeId: EMPLOYEE,
  backstopperId: 20,
  backstopperExists: true,
  startDate: '2026-11-02',
  endDate: '2026-11-06',
  comment: null,
  balance: balance(),
  active: [],
};
const evaluate = (patch: Partial<SubmissionInput>) =>
  evaluateSubmission({ ...base, ...patch });
const codeOf = (patch: Partial<SubmissionInput>) => evaluate(patch)?.code;
const debit = (halfDays: number): LedgerAction => ({
  kind: 'DEBIT',
  halfDays,
  occurredAt: new Date('2026-10-05T03:00:00Z'),
});

describe('evaluateSubmission', () => {
  // RULES §3-2, §3-4
  it('корректная заявка проходит', () => {
    expect(evaluate({})).toBeNull();
  });

  describe('каждый код с текстом каталога (architecture §8)', () => {
    it.each([
      // RULES §3-2
      [
        'backstopper не указан (undefined)',
        { backstopperId: undefined },
        'BACKSTOPPER_REQUIRED',
        'Укажите заменяющего сотрудника',
      ],
      // RULES §3-2
      [
        'backstopper null',
        { backstopperId: null },
        'BACKSTOPPER_REQUIRED',
        'Укажите заменяющего сотрудника',
      ],
      // RULES §3-3
      [
        'backstopper - сам заявитель',
        { backstopperId: EMPLOYEE },
        'BACKSTOPPER_IS_SELF',
        'Нельзя указать себя заменяющим',
      ],
      // RULES §3-3
      [
        'backstopper не найден',
        { backstopperExists: false },
        'BACKSTOPPER_NOT_FOUND',
        'Заменяющий сотрудник не найден',
      ],
      // RULES §3-4
      [
        'начало позже конца',
        { startDate: '2026-11-06', endDate: '2026-11-02' },
        'VACATION_DATES_ORDER',
        'Дата начала позже даты окончания',
      ],
      // RULES §3-4
      [
        'через Новый год',
        { startDate: '2026-12-28', endDate: '2027-01-08' },
        'VACATION_CROSSES_YEAR',
        'Заявка не может охватывать два года, подайте две заявки',
      ],
      // RULES §3-4
      [
        'только выходные',
        { startDate: '2026-11-07', endDate: '2026-11-08' },
        'VACATION_NO_WORK_DAYS',
        'В заявке нет ни одного рабочего дня',
      ],
      // RULES §3-6
      [
        'до первого начисления',
        { balance: balance({ hireDate: '2026-10-12' }) },
        'NO_ACCRUAL_YET',
        'У вас ещё нет накопленных дней',
      ],
      // RULES §3-12
      [
        'начало раньше даты выхода',
        {
          startDate: '2026-02-02',
          endDate: '2026-02-06',
          comment: 'забыл оформить',
          balance: balance({ hireDate: '2026-02-03' }),
        },
        'VACATION_BEFORE_HIRE',
        'Дата начала отпуска раньше даты вашего выхода на работу',
      ],
      // RULES §3-7
      [
        'начало в прошлом году',
        {
          startDate: '2025-12-29',
          endDate: '2025-12-31',
          comment: 'забыл оформить',
        },
        'PAST_START_YEAR',
        'Начало отпуска в прошлом году: такая заявка не принимается',
      ],
      // RULES §3-7
      [
        'в прошлом без комментария',
        { startDate: '2026-10-19', endDate: '2026-10-20' },
        'PAST_COMMENT_REQUIRED',
        'Для отпуска с датой в прошлом укажите причину в комментарии',
      ],
    ] as const)('%s -> %s', (_name, patch, code, message) => {
      expect(evaluate(patch)).toEqual({ code, message });
    });

    // RULES §3-4 п.3
    it('пересечение: текст с датами и details', () => {
      expect(
        evaluate({
          active: [{ id: 7, startDate: '2026-11-05', endDate: '2026-11-10' }],
        }),
      ).toEqual({
        code: 'VACATION_OVERLAP',
        message:
          'У вас уже есть заявка на эти даты: с 2026-11-05 по 2026-11-10',
        details: { vacationId: 7, from: '2026-11-05', to: '2026-11-10' },
      });
    });

    // RULES §3-9: дни с запятой, details числами
    it('нехватка остатка: текст с днями через запятую и details', () => {
      // 37,5 сегодня + 2,5 на 1 ноября = 40; списано 37,5 -> доступно 2,5
      expect(evaluate({ balance: balance({ ledger: [debit(75)] }) })).toEqual({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Не хватает дней: доступно 2,5, в заявке 5',
        details: { available: 2.5, requested: 5 },
      });
    });
  });

  // architecture §8 «Порядок проверок»: из двух нарушений возвращается первое по порядку
  describe('порядок ошибок', () => {
    it.each([
      // RULES §3-2, §3-4
      [
        'BACKSTOPPER_REQUIRED раньше VACATION_DATES_ORDER',
        {
          backstopperId: null,
          startDate: '2026-11-06',
          endDate: '2026-11-02',
        },
        'BACKSTOPPER_REQUIRED',
      ],
      // RULES §3-3
      [
        'BACKSTOPPER_IS_SELF раньше BACKSTOPPER_NOT_FOUND',
        { backstopperId: EMPLOYEE, backstopperExists: false },
        'BACKSTOPPER_IS_SELF',
      ],
      // RULES §3-3, §3-4
      [
        'BACKSTOPPER_NOT_FOUND раньше VACATION_DATES_ORDER',
        {
          backstopperExists: false,
          startDate: '2026-11-06',
          endDate: '2026-11-02',
        },
        'BACKSTOPPER_NOT_FOUND',
      ],
      // RULES §3-4
      [
        'VACATION_DATES_ORDER раньше VACATION_CROSSES_YEAR',
        { startDate: '2027-01-05', endDate: '2026-12-30' },
        'VACATION_DATES_ORDER',
      ],
      // RULES §3-4
      [
        'VACATION_CROSSES_YEAR раньше VACATION_NO_WORK_DAYS',
        // сб 2022-12-31 - вс 2023-01-01: два года и ни одного рабочего дня
        { startDate: '2022-12-31', endDate: '2023-01-01' },
        'VACATION_CROSSES_YEAR',
      ],
      // RULES §3-4, §3-6
      [
        'VACATION_NO_WORK_DAYS раньше NO_ACCRUAL_YET',
        {
          startDate: '2026-11-07',
          endDate: '2026-11-08',
          balance: balance({ hireDate: '2026-10-12' }),
        },
        'VACATION_NO_WORK_DAYS',
      ],
      // RULES §3-6, §3-12
      [
        'NO_ACCRUAL_YET раньше VACATION_BEFORE_HIRE',
        {
          startDate: '2026-10-05',
          endDate: '2026-10-09',
          comment: 'причина',
          balance: balance({ hireDate: '2026-10-12' }),
        },
        'NO_ACCRUAL_YET',
      ],
      // RULES §3-12, §3-7
      [
        'VACATION_BEFORE_HIRE раньше PAST_START_YEAR',
        {
          startDate: '2025-12-29',
          endDate: '2025-12-31',
          balance: balance({ hireDate: '2026-01-12' }),
        },
        'VACATION_BEFORE_HIRE',
      ],
      // RULES §3-7
      [
        'PAST_START_YEAR раньше PAST_COMMENT_REQUIRED',
        { startDate: '2025-12-29', endDate: '2025-12-31' },
        'PAST_START_YEAR',
      ],
      // RULES §3-7, §3-4
      [
        'PAST_COMMENT_REQUIRED раньше VACATION_OVERLAP',
        {
          startDate: '2026-10-19',
          endDate: '2026-10-20',
          active: [{ id: 1, startDate: '2026-10-19', endDate: '2026-10-23' }],
        },
        'PAST_COMMENT_REQUIRED',
      ],
      // RULES §3-4, §3-9
      [
        'VACATION_OVERLAP раньше INSUFFICIENT_BALANCE',
        {
          balance: balance({ ledger: [debit(80)] }),
          active: [{ id: 1, startDate: '2026-11-06', endDate: '2026-11-06' }],
        },
        'VACATION_OVERLAP',
      ],
    ] as const)('%s', (_name, patch, code) => {
      expect(codeOf(patch)).toBe(code);
    });
  });

  describe('пересечение (RULES §3-4 п.3)', () => {
    // RULES §3-4 п.3: при нескольких пересечениях в тексте заявка с самой ранней датой начала
    it('несколько пересечений: берётся самая ранняя по началу', () => {
      const result = evaluate({
        startDate: '2026-11-02',
        endDate: '2026-11-20',
        active: [
          { id: 3, startDate: '2026-11-16', endDate: '2026-11-17' },
          { id: 9, startDate: '2026-11-03', endDate: '2026-11-04' },
          { id: 5, startDate: '2026-11-10', endDate: '2026-11-10' },
        ],
      });
      expect(result?.details).toEqual({
        vacationId: 9,
        from: '2026-11-03',
        to: '2026-11-04',
      });
    });

    // RULES §3-4 п.3: границы включительно
    it.each([
      ['касается концом', '2026-10-26', '2026-11-02', 'VACATION_OVERLAP'],
      ['касается началом', '2026-11-06', '2026-11-13', 'VACATION_OVERLAP'],
      ['вплотную до', '2026-10-26', '2026-11-01', undefined],
      ['вплотную после', '2026-11-07', '2026-11-13', undefined],
    ])('%s', (_name, startDate, endDate, code) => {
      expect(codeOf({ active: [{ id: 1, startDate, endDate }] })).toBe(code);
    });
  });

  describe('остаток (RULES §3-9, §3-10)', () => {
    // RULES §3-9: граница включительно; доступно 2,5 на 2026-11-02 (40 - 37,5)
    it('ровно доступное число рабочих дней проходит, на один больше - нет', () => {
      const tight = balance({ ledger: [debit(76)] }); // доступно 2
      expect(
        codeOf({
          startDate: '2026-11-02',
          endDate: '2026-11-03',
          balance: tight,
        }),
      ).toBeUndefined();
      expect(
        codeOf({
          startDate: '2026-11-02',
          endDate: '2026-11-04',
          balance: tight,
        }),
      ).toBe('INSUFFICIENT_BALANCE');
    });

    // RULES §3-10: остаток считается на дату начала отпуска (начисления до неё включительно)
    it('остаток считается на дату начала: начисление 1 декабря учитывается', () => {
      const low = balance({ ledger: [debit(80)] }); // сегодня -2,5, на 1 ноября 0, на 1 декабря 2,5
      expect(
        codeOf({
          startDate: '2026-11-30',
          endDate: '2026-11-30',
          balance: low,
        }),
      ).toBe('INSUFFICIENT_BALANCE');
      expect(
        codeOf({
          startDate: '2026-12-01',
          endDate: '2026-12-02',
          balance: low,
        }),
      ).toBeUndefined();
    });

    // RULES §3-10: для начала сегодня и в прошлом берётся баланс сегодня
    it('начало сегодня: баланс сегодня', () => {
      const low = balance({ ledger: [debit(74)] }); // сегодня 0,5
      expect(
        evaluate({
          startDate: '2026-10-21',
          endDate: '2026-10-21',
          balance: low,
        })?.details,
      ).toEqual({ available: 0.5, requested: 1 });
    });

    // RULES §2, §3-9: первое начисление 0 (выход 31 октября) -> заявка останавливается остатком
    it('первое начисление 0: INSUFFICIENT_BALANCE с available 0', () => {
      expect(
        evaluate({
          balance: balance({ hireDate: '2026-10-31', today: '2026-11-02' }),
          startDate: '2026-11-02',
          endDate: '2026-11-02',
        }),
      ).toEqual({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Не хватает дней: доступно 0, в заявке 1',
        details: { available: 0, requested: 1 },
      });
    });

    // RULES §6-4: отрицательный остаток показывается со знаком минус
    it('отрицательный остаток: типографский минус в тексте, число в details', () => {
      // сегодня 37,5 - 41 = -3,5; на 2026-11-02 -1
      expect(evaluate({ balance: balance({ ledger: [debit(82)] }) })).toEqual({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Не хватает дней: доступно −1, в заявке 5',
        details: { available: -1, requested: 5 },
      });
    });
  });
});

describe('formatDays', () => {
  // RULES §2-7, §6-4: шаг 0,5, запятая, типографский минус
  it.each([
    [0, '0'],
    [5, '5'],
    [2.5, '2,5'],
    [-3, '−3'],
    [-0.5, '−0,5'],
  ])('%p -> %s', (days, text) => {
    expect(formatDays(days)).toBe(text);
  });
});

// Перенос (S6-b): исходный отпуск пн 2026-11-09 – пт 2026-11-13 (5 раб. дней), сегодня 2026-10-21.
const source = (patch: Partial<TransferSourceFacts> = {}) =>
  transferSourceError({
    actorId: EMPLOYEE,
    employeeId: EMPLOYEE,
    status: VacationStatus.APPROVED,
    startDate: '2026-11-09',
    today: '2026-10-21',
    transferPending: false,
    ...patch,
  });
const sourceCode = (patch: Partial<TransferSourceFacts> = {}) => {
  const e = source(patch);
  return e && `${e.status} ${e.code}`;
};

describe('transferSourceError: можно ли переносить отпуск', () => {
  // RULES §5-1, §5-2: одобренный отпуск до начала
  it('одобренный до начала - можно; накануне начала тоже', () => {
    expect(source()).toBeNull();
    expect(source({ today: '2026-11-08' })).toBeNull();
  });

  // RULES §5-2: перенос подаётся из своего отпуска
  it('не владелец - 403 FORBIDDEN', () => {
    expect(sourceCode({ actorId: 3 })).toBe('403 FORBIDDEN');
  });

  // RULES §10-1; DECISIONS 2026-10-28 17:06
  it.each([VacationStatus.CANCELLED, VacationStatus.REPLACED])(
    '%s - 409 ALREADY_PROCESSED',
    (status) => {
      expect(sourceCode({ status })).toBe('409 ALREADY_PROCESSED');
    },
  );

  // RULES §5-2: переносится только одобренный отпуск
  it.each([VacationStatus.PENDING, VacationStatus.REJECTED])(
    '%s - 422 TRANSFER_SOURCE_NOT_APPROVED',
    (status) => {
      expect(sourceCode({ status })).toBe('422 TRANSFER_SOURCE_NOT_APPROVED');
    },
  );

  // RULES §5-2 «недоступны «Отменить» и «Перенести»: сначала отменяется перенос»
  it('перенос уже ждёт решения - 409 TRANSFER_ALREADY_PENDING', () => {
    expect(source({ transferPending: true })).toEqual({
      status: 409,
      code: 'TRANSFER_ALREADY_PENDING',
      message:
        'Перенос этого отпуска уже ждёт решения; повторно перенести отпуск нельзя',
    });
  });

  // RULES §5-1, §5-9: начался, если сегодня ≥ даты начала
  it('в день начала и позже - 422 TRANSFER_STARTED', () => {
    expect(source({ today: '2026-11-09' })).toEqual({
      status: 422,
      code: 'TRANSFER_STARTED',
      message: 'Отпуск уже начался, перенести его нельзя',
    });
    expect(sourceCode({ today: '2026-11-20' })).toBe('422 TRANSFER_STARTED');
  });

  // DECISIONS 2026-10-28 17:06: порядок проверок состояния
  it('порядок проверок', () => {
    expect(sourceCode({ actorId: 3, status: VacationStatus.REPLACED })).toBe(
      '403 FORBIDDEN',
    );
    expect(
      sourceCode({ status: VacationStatus.REPLACED, today: '2026-11-20' }),
    ).toBe('409 ALREADY_PROCESSED');
    expect(
      sourceCode({ status: VacationStatus.PENDING, today: '2026-11-20' }),
    ).toBe('422 TRANSFER_SOURCE_NOT_APPROVED');
    expect(sourceCode({ transferPending: true, today: '2026-11-20' })).toBe(
      '409 TRANSFER_ALREADY_PENDING',
    );
  });
});

const transferBase: TransferInput = {
  employeeId: EMPLOYEE,
  backstopperId: 20,
  backstopperExists: true,
  startDate: '2026-11-16',
  endDate: '2026-11-20',
  today: '2026-10-21',
  sourceWorkDays: 5,
  active: [],
};
const transfer = (patch: Partial<TransferInput>) =>
  evaluateTransfer({ ...transferBase, ...patch });
const transferCode = (patch: Partial<TransferInput>) => transfer(patch)?.code;

describe('evaluateTransfer: новые даты переноса', () => {
  // RULES §5-2
  it('те же рабочие дни, начало в будущем - проходит', () => {
    expect(transfer({})).toBeNull();
  });

  // RULES §5-2 «начало сегодня допустимо»
  it('начало сегодня - проходит; вчера - TRANSFER_START_IN_PAST', () => {
    expect(
      transfer({ startDate: '2026-10-21', endDate: '2026-10-27' }),
    ).toBeNull();
    expect(
      transfer({ startDate: '2026-10-20', endDate: '2026-10-26' }),
    ).toEqual({
      code: 'TRANSFER_START_IN_PAST',
      message:
        'Начало переноса не может быть раньше сегодняшней даты; для прошлых дат подайте обычную заявку',
    });
  });

  // RULES §5-2: число рабочих дней должно совпасть
  it('другое число рабочих дней - TRANSFER_WORKDAYS_MISMATCH с объяснением', () => {
    expect(transfer({ endDate: '2026-11-19' })).toEqual({
      code: 'TRANSFER_WORKDAYS_MISMATCH',
      message: 'Число рабочих дней должно совпадать: было 5, в заявке 4',
      details: { old: 5, requested: 4 },
    });
  });

  // RULES §3-2, §3-3, §5-2: backstopper обязателен и для переноса
  it.each([
    ['не указан', { backstopperId: null }, 'BACKSTOPPER_REQUIRED'],
    ['undefined', { backstopperId: undefined }, 'BACKSTOPPER_REQUIRED'],
    ['сам заявитель', { backstopperId: EMPLOYEE }, 'BACKSTOPPER_IS_SELF'],
    ['не найден', { backstopperExists: false }, 'BACKSTOPPER_NOT_FOUND'],
  ] as [string, Partial<TransferInput>, string][])(
    'backstopper %s - %s',
    (_name, patch, expected) => {
      expect(transferCode(patch)).toBe(expected);
    },
  );

  // RULES §3-4, §5-2: перенос подчиняется правилам дробления
  it.each([
    [
      'начало позже окончания',
      '2026-11-20',
      '2026-11-16',
      'VACATION_DATES_ORDER',
    ],
    ['через Новый год', '2026-12-28', '2027-01-01', 'VACATION_CROSSES_YEAR'],
    ['только выходные', '2026-11-21', '2026-11-22', 'VACATION_NO_WORK_DAYS'],
  ])('%s - %s', (_name, startDate, endDate, expected) => {
    expect(transferCode({ startDate, endDate })).toBe(expected);
  });

  // RULES §5-2: с другими заявками сотрудника пересечение запрещено
  it('пересечение с другой активной заявкой - VACATION_OVERLAP', () => {
    expect(
      transfer({
        active: [{ id: 7, startDate: '2026-11-19', endDate: '2026-11-24' }],
      }),
    ).toEqual({
      code: 'VACATION_OVERLAP',
      message: 'У вас уже есть заявка на эти даты: с 2026-11-19 по 2026-11-24',
      details: { vacationId: 7, from: '2026-11-19', to: '2026-11-24' },
    });
  });

  // DECISIONS 2026-10-28 17:06: backstopper → период → начало → рабочие дни → пересечение
  it('порядок проверок', () => {
    const everywhere = [
      { id: 7, startDate: '2026-01-01', endDate: '2026-12-31' },
    ];
    expect(
      transferCode({
        backstopperId: null,
        startDate: '2026-11-20',
        endDate: '2026-11-16',
      }),
    ).toBe('BACKSTOPPER_REQUIRED');
    expect(
      transferCode({ startDate: '2026-10-17', endDate: '2026-10-18' }),
    ).toBe('VACATION_NO_WORK_DAYS');
    expect(
      transferCode({
        startDate: '2026-10-19',
        endDate: '2026-10-19',
        active: everywhere,
      }),
    ).toBe('TRANSFER_START_IN_PAST');
    expect(transferCode({ endDate: '2026-11-19', active: everywhere })).toBe(
      'TRANSFER_WORKDAYS_MISMATCH',
    );
  });
});
