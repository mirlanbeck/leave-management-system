import { VacationStatus } from '../generated/prisma/enums';
import {
  cancelError,
  hasStarted,
  recallError,
  type CancelFacts,
  type RecallFacts,
} from './cancel-rules';

// Отпуск пн 2026-11-09 – пт 2026-11-13
const START = '2026-11-09';
const END = '2026-11-13';

const cancel = (patch: Partial<CancelFacts> = {}) =>
  cancelError({
    actorId: 6,
    employeeId: 6,
    status: VacationStatus.APPROVED,
    startDate: START,
    today: '2026-10-21',
    ...patch,
  });

const recall = (patch: Partial<RecallFacts> = {}) =>
  recallError({
    actorIsHr: true,
    status: VacationStatus.APPROVED,
    startDate: START,
    endDate: END,
    today: '2026-11-11',
    returnDate: '2026-11-12',
    ...patch,
  });

const code = (e: { code: string; status: number } | null) =>
  e && `${e.status} ${e.code}`;

describe('hasStarted', () => {
  // RULES §5-9: начался, если сегодня ≥ даты начала
  it('накануне - нет, в день начала и позже - да', () => {
    expect(hasStarted(START, '2026-11-08')).toBe(false);
    expect(hasStarted(START, START)).toBe(true);
    expect(hasStarted(START, '2026-11-20')).toBe(true);
  });
});

describe('cancelError: отмена владельцем', () => {
  // RULES §5-4: до начала одобренный и «На согласовании» отменяет сам сотрудник
  it('владелец до начала: APPROVED и PENDING - можно', () => {
    expect(cancel()).toBeNull();
    expect(cancel({ status: VacationStatus.PENDING })).toBeNull();
    expect(cancel({ today: '2026-11-08' })).toBeNull();
  });

  // RULES §5-10: HR и руководитель чужой отпуск не отменяют
  it('не владелец - 403 FORBIDDEN', () => {
    expect(code(cancel({ actorId: 3 }))).toBe('403 FORBIDDEN');
  });

  // RULES §10-1: «Отменена», «Отклонена», «Заменена переносом» - уже обработана
  it.each([
    VacationStatus.CANCELLED,
    VacationStatus.REJECTED,
    VacationStatus.REPLACED,
  ])('статус %s - 409 ALREADY_PROCESSED', (status) => {
    expect(code(cancel({ status }))).toBe('409 ALREADY_PROCESSED');
  });

  // RULES §5-7, §5-9: в день начала сотрудник уже не отменяет
  it('APPROVED с даты начала - 403 CANCEL_STARTED_BY_EMPLOYEE', () => {
    expect(code(cancel({ today: START }))).toBe(
      '403 CANCEL_STARTED_BY_EMPLOYEE',
    );
    expect(cancel({ today: START })?.message).toBe(
      'Отпуск уже начался: отменить его сами вы не можете',
    );
  });

  // RULES §5-10: «На согласовании» после начала не отменяет никто
  it('PENDING с даты начала - 422 CANCEL_PENDING_AFTER_START', () => {
    expect(code(cancel({ status: VacationStatus.PENDING, today: START }))).toBe(
      '422 CANCEL_PENDING_AFTER_START',
    );
  });

  // DECISIONS 2026-10-28 15:41: порядок - владелец раньше статуса, статус раньше начала
  it('порядок проверок', () => {
    expect(code(cancel({ actorId: 3, status: VacationStatus.CANCELLED }))).toBe(
      '403 FORBIDDEN',
    );
    expect(
      code(cancel({ status: VacationStatus.CANCELLED, today: START })),
    ).toBe('409 ALREADY_PROCESSED');
  });
});

describe('recallError: отзыв HR', () => {
  // RULES §5-5, §5-6, §5-11: выход на начало, в середине и на окончание
  it.each([START, '2026-11-12', END])(
    'дата выхода %s - можно',
    (returnDate) => {
      expect(recall({ returnDate })).toBeNull();
    },
  );

  // RULES §5-5: отзывает только HR
  it('не HR - 403 FORBIDDEN', () => {
    expect(code(recall({ actorIsHr: false }))).toBe('403 FORBIDDEN');
  });

  // RULES §10-1
  it.each([VacationStatus.CANCELLED, VacationStatus.REPLACED])(
    'статус %s - 409 ALREADY_PROCESSED',
    (status) => {
      expect(code(recall({ status }))).toBe('409 ALREADY_PROCESSED');
    },
  );

  // RULES §5-5: отзывают только одобренный отпуск
  it.each([VacationStatus.PENDING, VacationStatus.REJECTED])(
    'статус %s - 422 RECALL_NOT_APPROVED',
    (status) => {
      expect(code(recall({ status }))).toBe('422 RECALL_NOT_APPROVED');
    },
  );

  // RULES §5-4, §5-9, §5-10: до начала HR не отменяет
  it('накануне начала - 422 RECALL_NOT_STARTED; в день начала можно', () => {
    expect(code(recall({ today: '2026-11-08', returnDate: START }))).toBe(
      '422 RECALL_NOT_STARTED',
    );
    expect(recall({ today: START, returnDate: START })).toBeNull();
  });

  // RULES §5-5: из завершённого отпуска отзыва нет; в день окончания можно
  it('после окончания - 422 RECALL_FINISHED', () => {
    expect(recall({ today: END })).toBeNull();
    expect(code(recall({ today: '2026-11-14' }))).toBe('422 RECALL_FINISHED');
  });

  // RULES §5-11: дата выхода от начала до окончания; относительно сегодня ограничений нет
  it('дата выхода вне отпуска - 422 RECALL_DATE_OUT_OF_RANGE', () => {
    expect(code(recall({ returnDate: '2026-11-14' }))).toBe(
      '422 RECALL_DATE_OUT_OF_RANGE',
    );
    expect(code(recall({ returnDate: '2026-11-08' }))).toBe(
      '422 RECALL_DATE_OUT_OF_RANGE',
    );
    expect(
      recall({ today: '2026-11-11', returnDate: '2026-11-10' }),
    ).toBeNull();
    expect(recall({ today: '2026-11-11', returnDate: END })).toBeNull();
  });

  // DECISIONS 2026-10-28 15:41: порядок проверок отзыва
  it('порядок проверок', () => {
    expect(
      code(recall({ actorIsHr: false, status: VacationStatus.CANCELLED })),
    ).toBe('403 FORBIDDEN');
    expect(
      code(recall({ status: VacationStatus.CANCELLED, today: '2026-11-01' })),
    ).toBe('409 ALREADY_PROCESSED');
    expect(
      code(recall({ status: VacationStatus.PENDING, today: '2026-11-01' })),
    ).toBe('422 RECALL_NOT_APPROVED');
    expect(
      code(recall({ today: '2026-11-01', returnDate: '2026-12-01' })),
    ).toBe('422 RECALL_NOT_STARTED');
    expect(
      code(recall({ today: '2026-11-20', returnDate: '2026-12-01' })),
    ).toBe('422 RECALL_FINISHED');
  });
});
