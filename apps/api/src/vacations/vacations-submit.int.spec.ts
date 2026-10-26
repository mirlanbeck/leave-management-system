/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- тела ответов supertest и строки pg имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { addDays, isWorkDay } from '../domain';
import { newRequestMail } from '../mail/mail-templates';
import {
  bearer,
  loginAs,
  passwordHash,
  setDbClock,
} from '../testing/int-helpers';
import { createTestApp } from '../testing/test-app';
import {
  RulesOrgKey,
  createPool,
  insertLedger,
  insertVacation,
  seedRulesOrg,
  shiftHireDate,
  truncateAll,
} from '../testing/test-db';

// Среда 2026-10-21, 09:17:42.123 по Бишкеку (UTC+6): нецелое значение, чтобы createdAt сравнивался точно
const NOW = '2026-10-21T03:17:42.123Z';

type Body = Record<string, unknown>;

/** Дата окончания так, чтобы в заявке было ровно `n` рабочих дней начиная с `start`. */
function endAfterWorkDays(start: string, n: number): string {
  let date = start;
  let count = isWorkDay(date) ? 1 : 0;
  while (count < n) {
    date = addDays(date, 1);
    if (isWorkDay(date)) count += 1;
  }
  return date;
}

describe('подача заявки: POST /vacations (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;
  let tokens: Partial<Record<RulesOrgKey, string>>;

  const token = async (login: RulesOrgKey) =>
    (tokens[login] ??= await loginAs(app, login));
  // токен берётся до создания запроса: вход закрывает временный сервер supertest
  const post = async (login: RulesOrgKey, body: Body) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer()).post('/vacations').set(auth).send(body);
  };
  const forecast = async (on: string) => {
    const auth = bearer(await token('employee1'));
    return request(app.getHttpServer()).get(`/me/balance?on=${on}`).set(auth);
  };
  /** Корректное тело для employee1: пн–пт 2026-11-02…06, заменяющий employee2. */
  const valid = (patch: Body = {}): Body => ({
    startDate: '2026-11-02',
    endDate: '2026-11-06',
    backstopperId: ids.employee2,
    ...patch,
  });
  const count = async (table: 'Vacation' | 'OutboxMessage') =>
    Number(
      (await pool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n,
    );
  const mails = async () =>
    (
      await pool.query(
        `SELECT type, "vacationId", "recipientId", subject, body, status, "createdAt"
         FROM "OutboxMessage" ORDER BY id`,
      )
    ).rows;
  /** Списание, после которого «баланс сегодня» employee1 равен 37,5 - halfDays/2. */
  const spend = async (halfDays: number) => {
    const v = await insertVacation(pool, {
      employeeId: ids.employee1,
      backstopperId: ids.employee2,
      start: '2026-03-02',
      end: '2026-03-06',
      status: 'APPROVED',
    });
    await insertLedger(pool, {
      kind: 'DEBIT',
      vacationId: v,
      halfDays,
      occurredAt: '2026-02-20T03:00:00Z',
    });
  };

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, NOW);
    ids = await seedRulesOrg(pool, await passwordHash());
    tokens = {};
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §7-1
  it('без токена 401', async () => {
    const res = await request(app.getHttpServer()).post('/vacations').send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  describe('успешная подача', () => {
    // RULES §3-2, §3-11, §9-1: 201, статус «На согласовании», workDays считает сервер, createdAt из Clock
    it('201 и заявка PENDING в форме architecture §7', async () => {
      const res = await post('employee1', valid({ comment: '  семья  ' }));
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(Number),
        employee: { id: ids.employee1, fullName: 'Сотрудник employee1' },
        backstopper: { id: ids.employee2, fullName: 'Сотрудник employee2' },
        startDate: '2026-11-02',
        endDate: '2026-11-06',
        workDays: 5,
        status: 'PENDING',
        comment: 'семья',
        replacesId: null,
        createdAt: NOW,
        decidedBy: null,
        decidedAt: null,
        decisionComment: null,
        cancelledAt: null,
        returnDate: null,
        transferPending: false,
        oldVacationKept: false,
        actions: [],
      });
      const auth = bearer(await token('employee1'));
      const card = await request(app.getHttpServer())
        .get(`/vacations/${res.body.id}`)
        .set(auth);
      expect(card.body).toEqual(res.body);
    });

    // RULES §3-8: комментарий необязателен; пустой хранится как null
    it.each([
      ['без поля', {}],
      ['null', { comment: null }],
      ['пустая строка', { comment: '' }],
      ['одни пробелы', { comment: '   ' }],
    ])('комментарий %s -> null', async (_name, patch) => {
      const res = await post('employee1', valid(patch));
      expect(res.status).toBe(201);
      expect(res.body.comment).toBeNull();
    });

    // RULES §3-3: занятость заменяющего выбор не блокирует
    it('у backstopper одобренный отпуск на те же даты -> 201', async () => {
      await insertVacation(pool, {
        employeeId: ids.employee2,
        backstopperId: ids.employee1,
        start: '2026-11-02',
        end: '2026-11-06',
        status: 'APPROVED',
      });
      expect((await post('employee1', valid())).status).toBe(201);
    });

    // RULES §3-3: руководитель заявителя и HR тоже могут быть backstopper
    it.each(['manager1', 'hr'] as const)(
      'backstopper %s -> 201',
      async (who) => {
        const res = await post('employee1', valid({ backstopperId: ids[who] }));
        expect(res.status).toBe(201);
      },
    );
  });

  describe('400 VALIDATION_FAILED: форма запроса', () => {
    // RULES §3-2: лишние поля, в том числе workDays, employeeId и status, отклоняются
    it.each([
      ['workDays от клиента', { workDays: 1 }, 'workDays'],
      ['employeeId (подача за другого)', { employeeId: 1 }, 'employeeId'],
      ['status', { status: 'APPROVED' }, 'status'],
    ])('%s', async (_name, patch, field) => {
      const res = await post('employee1', valid(patch));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.details.fields)).toContain(field);
      expect(await count('Vacation')).toBe(0);
    });

    // RULES §3-2: даты обязательны; неверный тип полей
    it.each([
      ['нет startDate', { startDate: undefined }, 'startDate'],
      ['нет endDate', { endDate: undefined }, 'endDate'],
      ['startDate числом', { startDate: 20261102 }, 'startDate'],
      ['backstopperId строкой', { backstopperId: '5' }, 'backstopperId'],
      ['backstopperId дробный', { backstopperId: 1.5 }, 'backstopperId'],
      ['comment числом', { comment: 5 }, 'comment'],
    ])('%s', async (_name, patch, field) => {
      const res = await post('employee1', valid(patch));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.details.fields)).toContain(field);
    });

    // RULES §1-4: формат YYYY-MM-DD, существующая дата, годы 2000–2100 (DECISIONS [S4])
    it.each([
      ['startDate', '1999-12-31'],
      ['startDate', '2101-01-01'],
      ['startDate', '2026-02-30'],
      ['startDate', '2026-1-1'],
      ['endDate', '2101-01-01'],
      ['endDate', '1999-12-31'],
      ['endDate', ''],
    ])('%s = "%s" -> 400', async (field, value) => {
      const res = await post('employee1', valid({ [field]: value }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.details.fields)).toEqual([field]);
    });

    // RULES §1-4: обе даты неверны -> оба поля в details.fields
    it('обе даты неверны -> оба поля', async () => {
      const res = await post(
        'employee1',
        valid({ startDate: 'x', endDate: '2101-01-01' }),
      );
      expect(res.status).toBe(400);
      expect(Object.keys(res.body.details.fields).sort()).toEqual([
        'endDate',
        'startDate',
      ]);
    });

    // RULES §1-4: граничные годы 2000 и 2100 принимаются (дальше действуют правила §3)
    it('год 2000 проходит форму, дальше действуют правила §3 (422, не 400)', async () => {
      const res = await post(
        'employee1',
        valid({ startDate: '2000-01-03', endDate: '2000-01-07', comment: 'x' }),
      );
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VACATION_BEFORE_HIRE'); // выход 2022-03-15
    });

    // RULES §1-4, §3-10
    it('год 2100 проходит: 201', async () => {
      const res = await post(
        'employee1',
        valid({ startDate: '2100-12-27', endDate: '2100-12-31' }),
      );
      expect(res.status).toBe(201);
      expect(res.body.workDays).toBe(5);
    });
  });

  describe('422: каждый код с текстом каталога (architecture §8)', () => {
    // RULES §3-2: backstopper обязателен; отсутствие или null -> 422, не 400 (DECISIONS [S4])
    it.each([
      ['нет поля', { backstopperId: undefined }],
      ['null', { backstopperId: null }],
    ])('backstopper %s -> BACKSTOPPER_REQUIRED', async (_name, patch) => {
      const res = await post('employee1', valid(patch));
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'BACKSTOPPER_REQUIRED',
        message: 'Укажите заменяющего сотрудника',
      });
    });

    // RULES §3-3
    it('сам себе backstopper -> BACKSTOPPER_IS_SELF', async () => {
      const res = await post(
        'employee1',
        valid({ backstopperId: ids.employee1 }),
      );
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'BACKSTOPPER_IS_SELF',
        message: 'Нельзя указать себя заменяющим',
      });
    });

    // RULES §3-3: несуществующий и заведомо невозможный id (вне Int4, 0, минус) -> NOT_FOUND, не 500
    it.each([999999, 0, -5, 99999999999])(
      'backstopperId %p -> BACKSTOPPER_NOT_FOUND',
      async (backstopperId) => {
        const res = await post('employee1', valid({ backstopperId }));
        expect(res.status).toBe(422);
        expect(res.body).toEqual({
          statusCode: 422,
          code: 'BACKSTOPPER_NOT_FOUND',
          message: 'Заменяющий сотрудник не найден',
        });
      },
    );

    // RULES §3-4, §3-6, §3-7
    it.each([
      [
        'начало позже конца',
        { startDate: '2026-11-06', endDate: '2026-11-02' },
        'VACATION_DATES_ORDER',
        'Дата начала позже даты окончания',
      ],
      [
        'через Новый год',
        { startDate: '2026-12-28', endDate: '2027-01-08' },
        'VACATION_CROSSES_YEAR',
        'Заявка не может охватывать два года, подайте две заявки',
      ],
      [
        'только выходные',
        { startDate: '2026-11-07', endDate: '2026-11-08' },
        'VACATION_NO_WORK_DAYS',
        'В заявке нет ни одного рабочего дня',
      ],
      [
        'начало в прошлом году',
        { startDate: '2025-12-29', endDate: '2025-12-31', comment: 'забыл' },
        'PAST_START_YEAR',
        'Начало отпуска в прошлом году: такая заявка не принимается',
      ],
      [
        'в прошлом без комментария',
        { startDate: '2026-10-19', endDate: '2026-10-20' },
        'PAST_COMMENT_REQUIRED',
        'Для отпуска с датой в прошлом укажите причину в комментарии',
      ],
    ])('%s -> %s', async (_name, patch, code, message) => {
      const res = await post('employee1', valid(patch));
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ statusCode: 422, code, message });
    });

    // RULES §3-6: Сотрудник 3 (выход 2026-10-12) до 1 ноября заявку подать не может
    it('до первого начисления -> NO_ACCRUAL_YET', async () => {
      const res = await post(
        'employee3',
        valid({ backstopperId: ids.employee1 }),
      );
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'NO_ACCRUAL_YET',
        message: 'У вас ещё нет накопленных дней',
      });
    });

    // RULES §3-12
    it('начало раньше даты выхода -> VACATION_BEFORE_HIRE', async () => {
      await shiftHireDate(pool, ids.employee1, '2026-02-03');
      const res = await post(
        'employee1',
        valid({ startDate: '2026-02-02', endDate: '2026-02-06', comment: 'x' }),
      );
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'VACATION_BEFORE_HIRE',
        message: 'Дата начала отпуска раньше даты вашего выхода на работу',
      });
    });

    // RULES §3-4 п.3: пересечение с активной заявкой (PENDING и APPROVED)
    it.each(['PENDING', 'APPROVED'] as const)(
      'пересечение с %s -> VACATION_OVERLAP с датами',
      async (status) => {
        const other = await insertVacation(pool, {
          employeeId: ids.employee1,
          backstopperId: ids.employee2,
          start: '2026-11-05',
          end: '2026-11-10',
          status,
        });
        const res = await post('employee1', valid());
        expect(res.status).toBe(422);
        expect(res.body).toEqual({
          statusCode: 422,
          code: 'VACATION_OVERLAP',
          message:
            'У вас уже есть заявка на эти даты: с 2026-11-05 по 2026-11-10',
          details: { vacationId: other, from: '2026-11-05', to: '2026-11-10' },
        });
      },
    );

    // RULES §3-4 п.3: несколько пересечений -> в тексте самая ранняя по началу
    it('несколько пересечений: самая ранняя по дате начала', async () => {
      const late = { start: '2026-11-16', end: '2026-11-17' };
      const early = { start: '2026-11-03', end: '2026-11-04' };
      for (const d of [late, early]) {
        await insertVacation(pool, {
          employeeId: ids.employee1,
          backstopperId: ids.employee2,
          ...d,
        });
      }
      const res = await post(
        'employee1',
        valid({ startDate: '2026-11-02', endDate: '2026-11-20' }),
      );
      expect(res.body.message).toBe(
        'У вас уже есть заявка на эти даты: с 2026-11-03 по 2026-11-04',
      );
    });

    // RULES §3-4 п.3: отклонённые, отменённые и заменённые заявки не мешают
    it.each(['REJECTED', 'CANCELLED', 'REPLACED'] as const)(
      'заявка %s на те же даты не мешает',
      async (status) => {
        await insertVacation(pool, {
          employeeId: ids.employee1,
          backstopperId: ids.employee2,
          start: '2026-11-02',
          end: '2026-11-06',
          status,
        });
        expect((await post('employee1', valid())).status).toBe(201);
      },
    );

    // RULES §3-4 п.3: пересекаются только заявки того же сотрудника
    it('заявка другого сотрудника на те же даты не мешает', async () => {
      await insertVacation(pool, {
        employeeId: ids.employee4,
        backstopperId: ids.employee5,
        start: '2026-11-02',
        end: '2026-11-06',
      });
      expect((await post('employee1', valid())).status).toBe(201);
    });

    // RULES §3-9
    it('не хватает дней -> INSUFFICIENT_BALANCE с днями через запятую', async () => {
      await spend(75); // сегодня 0, на 2026-11-02 доступно 2,5
      const res = await post('employee1', valid());
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'INSUFFICIENT_BALANCE',
        message: 'Не хватает дней: доступно 2,5, в заявке 5',
        details: { available: 2.5, requested: 5 },
      });
    });

    // RULES §6-4: после сдвига даты выхода остаток отрицательный - со знаком минус
    it('отрицательный остаток: «доступно −…»', async () => {
      await spend(82); // сегодня -3,5, на 2026-11-02 -1
      const res = await post('employee1', valid());
      expect(res.body.message).toBe('Не хватает дней: доступно −1, в заявке 5');
      expect(res.body.details).toEqual({ available: -1, requested: 5 });
    });
  });

  // architecture §8 «Порядок проверок»: из двух нарушений возвращается первое по порядку
  describe('порядок ошибок', () => {
    const order: [string, () => Promise<void>, Body, string][] = [
      [
        'BACKSTOPPER_REQUIRED раньше VACATION_DATES_ORDER',
        async () => {},
        { backstopperId: null, startDate: '2026-11-06', endDate: '2026-11-02' },
        'BACKSTOPPER_REQUIRED',
      ],
      [
        'BACKSTOPPER_NOT_FOUND раньше VACATION_DATES_ORDER',
        async () => {},
        {
          backstopperId: 999999,
          startDate: '2026-11-06',
          endDate: '2026-11-02',
        },
        'BACKSTOPPER_NOT_FOUND',
      ],
      [
        'VACATION_DATES_ORDER раньше VACATION_CROSSES_YEAR',
        async () => {},
        { startDate: '2027-01-05', endDate: '2026-12-30' },
        'VACATION_DATES_ORDER',
      ],
      [
        'VACATION_CROSSES_YEAR раньше VACATION_NO_WORK_DAYS',
        async () => {},
        { startDate: '2022-12-31', endDate: '2023-01-01' },
        'VACATION_CROSSES_YEAR',
      ],
      [
        'VACATION_NO_WORK_DAYS раньше NO_ACCRUAL_YET',
        () => shiftHireDate(pool, ids.employee1, '2026-10-12'),
        { startDate: '2026-11-07', endDate: '2026-11-08' },
        'VACATION_NO_WORK_DAYS',
      ],
      [
        'NO_ACCRUAL_YET раньше VACATION_BEFORE_HIRE',
        () => shiftHireDate(pool, ids.employee1, '2026-10-12'),
        { startDate: '2026-10-05', endDate: '2026-10-09', comment: 'x' },
        'NO_ACCRUAL_YET',
      ],
      [
        'VACATION_BEFORE_HIRE раньше PAST_START_YEAR',
        () => shiftHireDate(pool, ids.employee1, '2026-01-12'),
        { startDate: '2025-12-29', endDate: '2025-12-31' },
        'VACATION_BEFORE_HIRE',
      ],
      [
        'PAST_START_YEAR раньше PAST_COMMENT_REQUIRED',
        async () => {},
        { startDate: '2025-12-29', endDate: '2025-12-31' },
        'PAST_START_YEAR',
      ],
      [
        'PAST_COMMENT_REQUIRED раньше VACATION_OVERLAP',
        async () => {
          await insertVacation(pool, {
            employeeId: ids.employee1,
            backstopperId: ids.employee2,
            start: '2026-10-19',
            end: '2026-10-23',
          });
        },
        { startDate: '2026-10-19', endDate: '2026-10-20' },
        'PAST_COMMENT_REQUIRED',
      ],
      [
        'VACATION_OVERLAP раньше INSUFFICIENT_BALANCE',
        async () => {
          await spend(80);
          await insertVacation(pool, {
            employeeId: ids.employee1,
            backstopperId: ids.employee2,
            start: '2026-11-06',
            end: '2026-11-06',
          });
        },
        {},
        'VACATION_OVERLAP',
      ],
    ];

    // RULES §3-2, §3-3, §3-4, §3-6, §3-7, §3-9, §3-12
    it.each(order)('%s', async (_name, arrange, patch, code) => {
      await arrange();
      const res = await post('employee1', valid(patch));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(code);
    });

    // RULES §3-2, §3-3: проверки backstopper раньше остальных
    it('BACKSTOPPER_IS_SELF раньше VACATION_DATES_ORDER', async () => {
      const res = await post(
        'employee1',
        valid({
          backstopperId: ids.employee1,
          startDate: '2026-11-06',
          endDate: '2026-11-02',
        }),
      );
      expect(res.body.code).toBe('BACKSTOPPER_IS_SELF');
    });
  });

  describe('«в прошлом» и дата выхода (RULES §3-7, §3-12)', () => {
    // RULES §3-7: вчера - «в прошлом», нужен комментарий
    it('вчера без комментария -> PAST_COMMENT_REQUIRED, с комментарием -> 201', async () => {
      const day = { startDate: '2026-10-20', endDate: '2026-10-20' };
      expect((await post('employee1', valid(day))).body.code).toBe(
        'PAST_COMMENT_REQUIRED',
      );
      expect(
        (await post('employee1', valid({ ...day, comment: '   ' }))).body.code,
      ).toBe('PAST_COMMENT_REQUIRED');
      const res = await post(
        'employee1',
        valid({ ...day, comment: '  забыл оформить ' }),
      );
      expect(res.status).toBe(201);
      expect(res.body.comment).toBe('забыл оформить');
    });

    // RULES §3-7: начало сегодня «в прошлом» не считается
    it('сегодня без комментария -> 201', async () => {
      const res = await post(
        'employee1',
        valid({ startDate: '2026-10-21', endDate: '2026-10-23' }),
      );
      expect(res.status).toBe(201);
    });

    // RULES §3-7: прошлый год отклоняется даже с комментарием
    it('прошлый год -> PAST_START_YEAR', async () => {
      const res = await post(
        'employee1',
        valid({ startDate: '2025-12-01', endDate: '2025-12-05', comment: 'x' }),
      );
      expect(res.body.code).toBe('PAST_START_YEAR');
    });

    // RULES §3-12: начало в день выхода допустимо, накануне - нет
    it('начало в день выхода -> 201; накануне -> VACATION_BEFORE_HIRE', async () => {
      // выход 2026-09-01: 2,5 на 1 октября; к сегодня 2,5 (сентябрь целиком 30/30)
      await shiftHireDate(pool, ids.employee1, '2026-09-01');
      const before = await post(
        'employee1',
        valid({ startDate: '2026-08-31', endDate: '2026-09-01', comment: 'x' }),
      );
      expect(before.body.code).toBe('VACATION_BEFORE_HIRE');
      const res = await post(
        'employee1',
        valid({ startDate: '2026-09-01', endDate: '2026-09-02', comment: 'x' }),
      );
      expect(res.status).toBe(201);
    });

    // RULES §2-3, §3-6, §3-9: выход 31 октября - первое начисление 0; после 1 ноября заявку
    // останавливает остаток
    it('первое начисление 0 -> INSUFFICIENT_BALANCE с available 0', async () => {
      await shiftHireDate(pool, ids.employee3, '2026-10-31');
      await setDbClock(pool, '2026-11-02T03:00:00Z');
      const res = await post(
        'employee3',
        valid({
          startDate: '2026-11-02',
          endDate: '2026-11-02',
          backstopperId: ids.employee1,
        }),
      );
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'INSUFFICIENT_BALANCE',
        message: 'Не хватает дней: доступно 0, в заявке 1',
        details: { available: 0, requested: 1 },
      });
    });
  });

  describe('остаток: прогноз /me/balance и проверка подачи совпадают (RULES §3-9, §3-10)', () => {
    // списано 35: сегодня 2,5; на 1 ноября 5; на 1 декабря 7,5; на 1 января 2027 10
    it.each(['2026-10-21', '2026-11-02', '2026-12-01', '2027-01-04'])(
      'D = %s: floor(прогноз) рабочих дней проходит, на один больше - нет',
      async (D) => {
        await spend(70);
        const available: number = (await forecast(D)).body.availableOn;
        const fits = Math.floor(available);
        expect(fits).toBeGreaterThan(0);

        const over = await post(
          'employee1',
          valid({ startDate: D, endDate: endAfterWorkDays(D, fits + 1) }),
        );
        expect(over.status).toBe(422);
        expect(over.body.code).toBe('INSUFFICIENT_BALANCE');
        expect(over.body.details).toEqual({ available, requested: fits + 1 });

        const ok = await post(
          'employee1',
          valid({ startDate: D, endDate: endAfterWorkDays(D, fits) }),
        );
        expect(ok.status).toBe(201);
        expect(ok.body.workDays).toBe(fits);
      },
    );

    // RULES §3-9: дни заявок «На согласовании» не резервируются
    it('PENDING не резервирует дни: прогноз не меняется, вторая заявка проходит', async () => {
      await spend(70); // на 2026-11-02 доступно 5
      expect((await post('employee1', valid())).status).toBe(201);
      expect((await forecast('2026-11-09')).body.availableOn).toBe(5);
      const second = await post(
        'employee1',
        valid({ startDate: '2026-11-09', endDate: '2026-11-13' }),
      );
      expect(second.status).toBe(201);
    });
  });

  describe('письмо NEW_REQUEST (RULES §8-2, §4-1, §4-2)', () => {
    // RULES §8-2, §4-1, §4-2, §8-6: получатель - согласующий; директор -> HR; HR -> заместитель
    it.each([
      ['employee1', 'manager1', 'employee2'],
      ['manager1', 'deputy', 'employee1'],
      ['hr', 'deputy', 'employee1'],
      ['deputy', 'director', 'hr'],
      ['director', 'hr', 'deputy'],
    ] as const)(
      'заявка %s -> письмо %s, backstopper писем не получает',
      async (who, approver, backstopper) => {
        const res = await post(who, valid({ backstopperId: ids[backstopper] }));
        expect(res.status).toBe(201);
        const rows = await mails();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          type: 'NEW_REQUEST',
          vacationId: res.body.id,
          recipientId: ids[approver],
          status: 'PENDING',
        });
      },
    );

    // RULES §8-2, §4-2: тема и текст из mail-templates; заявка директора - «Допуск HR»
    it.each([
      ['employee1', false],
      ['director', true],
    ] as const)('текст письма заявки %s', async (who, forHr) => {
      const res = await post(
        who,
        valid({ backstopperId: ids.hr, comment: ' семья ' }),
      );
      const [row] = await mails();
      expect({ subject: row.subject, body: row.body }).toEqual(
        newRequestMail({
          employeeName: `Сотрудник ${who}`,
          startDate: '2026-11-02',
          endDate: '2026-11-06',
          workDays: 5,
          backstopperName: 'Сотрудник hr',
          comment: 'семья',
          forHr,
        }),
      );
      expect(row.subject.startsWith('Допуск HR')).toBe(forHr);
      expect(res.status).toBe(201);
    });

    // RULES §9-1: createdAt письма и заявки - один момент Clock (замороженные демо-часы)
    it('createdAt письма и заявки равен Clock', async () => {
      const res = await post('employee1', valid());
      const [row] = await mails();
      expect((row.createdAt as Date).toISOString()).toBe(NOW);
      expect(res.body.createdAt).toBe(NOW);
    });

    // RULES §8-1, §10-1: при ошибке подачи ни заявки, ни письма
    it('отклонённая подача не создаёт ни заявки, ни письма', async () => {
      await post('employee1', valid({ backstopperId: null }));
      await post(
        'employee1',
        valid({ startDate: '2026-11-07', endDate: '2026-11-08' }),
      );
      expect(await count('Vacation')).toBe(0);
      expect(await count('OutboxMessage')).toBe(0);
    });
  });

  describe('конкурентность (RULES §10-1)', () => {
    // RULES §10-1: из параллельных пересекающихся заявок проходит одна
    it.each([2, 5])(
      '%i параллельных пересекающихся заявок: одна 201, остальные VACATION_OVERLAP',
      async (n) => {
        await token('employee1');
        const results = await Promise.all(
          Array.from({ length: n }, (_, i) =>
            post(
              'employee1',
              valid({
                startDate: addDays('2026-11-02', i),
                endDate: addDays('2026-11-13', i),
              }),
            ),
          ),
        );
        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([201, ...Array(n - 1).fill(422)]);
        for (const r of results.filter((x) => x.status === 422)) {
          expect(r.body.code).toBe('VACATION_OVERLAP');
        }
        expect(await count('Vacation')).toBe(1);
        expect(await count('OutboxMessage')).toBe(1);
      },
    );

    // RULES §10-1: двойной клик - одна заявка и ровно одно письмо
    it('двойной клик: одна заявка, одна строка NEW_REQUEST', async () => {
      await token('employee1');
      const [a, b] = await Promise.all([
        post('employee1', valid()),
        post('employee1', valid()),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      const rows = await mails();
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('NEW_REQUEST');
      expect(await count('Vacation')).toBe(1);
    });

    // RULES §10-1, architecture §6: взаимные backstopper не дают взаимной блокировки (40P01)
    it('взаимные backstopper двух сотрудников параллельно: обе 201', async () => {
      await token('employee1');
      await token('employee2');
      for (let week = 0; week < 5; week += 1) {
        const start = addDays('2026-11-02', week * 7);
        const end = addDays(start, 4);
        const [a, b] = await Promise.all([
          post('employee1', {
            startDate: start,
            endDate: end,
            backstopperId: ids.employee2,
          }),
          post('employee2', {
            startDate: start,
            endDate: end,
            backstopperId: ids.employee1,
          }),
        ]);
        expect([a.status, b.status]).toEqual([201, 201]);
      }
      expect(await count('Vacation')).toBe(10);
      expect(await count('OutboxMessage')).toBe(10);
    });
  });
});
