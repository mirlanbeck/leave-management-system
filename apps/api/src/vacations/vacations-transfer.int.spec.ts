/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- тела ответов supertest и строки pg имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { EventBus } from '../events/event-bus';
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

// Среда 2026-10-21, 09:17 по Бишкеку. Баланс employee1 (выход 2022-03-15) сегодня 37,5.
// Исходный отпуск A: пн 2026-11-09 – пт 2026-11-13, 5 рабочих дней, одобрен (списание 5 дней).
// Перенос по умолчанию: пн 2026-11-16 – пт 2026-11-20.
const NOW = '2026-10-21T03:17:42.123Z';
// Среда 2026-11-11, 09:00 по Бишкеку: отпуск A идёт
const DURING = '2026-11-11T03:00:00.000Z';
const START = '2026-11-09';
const END = '2026-11-13';
const NEW_START = '2026-11-16';
const NEW_END = '2026-11-20';

type Body = Record<string, unknown>;
type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REPLACED';

describe('перенос: POST /vacations/{id}/transfer, блокировки и цепочка (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;
  let tokens: Partial<Record<RulesOrgKey, string>>;

  const token = async (login: RulesOrgKey) =>
    (tokens[login] ??= await loginAs(app, login));
  // токен берётся до создания запроса: вход закрывает временный сервер supertest
  const post = async (login: RulesOrgKey, path: string, body?: Body) => {
    const auth = bearer(await token(login));
    const req = request(app.getHttpServer()).post(path).set(auth);
    return body === undefined ? req : req.send(body);
  };
  const get = async (login: RulesOrgKey, path: string) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer()).get(path).set(auth);
  };
  const backstopperOf = (who: RulesOrgKey) =>
    who === 'employee2' ? ids.employee1 : ids.employee2;
  /** Перенос с новыми датами; backstopper по умолчанию тот же, что у фикстуры. */
  const transfer = (
    login: RulesOrgKey,
    id: number | string,
    patch: Body = {},
  ) =>
    post(login, `/vacations/${id}/transfer`, {
      startDate: NEW_START,
      endDate: NEW_END,
      backstopperId: backstopperOf(login),
      ...patch,
    });
  const cancel = (login: RulesOrgKey, id: number) =>
    post(login, `/vacations/${id}/cancel`, {});
  const recall = (login: RulesOrgKey, id: number, returnDate: string) =>
    post(login, `/vacations/${id}/recall`, { returnDate });
  const balance = async (login: RulesOrgKey) =>
    (await get(login, '/me/balance')).body.balance;

  /** Заявка в статусе; у «Одобрена» и «Заменена переносом» без replacesId - списание всех дней. */
  const vacation = async (
    who: RulesOrgKey,
    patch: {
      start?: string;
      end?: string;
      workDays?: number;
      status?: Status;
      replacesId?: number;
    } = {},
  ) => {
    const status = patch.status ?? 'APPROVED';
    const workDays = patch.workDays ?? 5;
    const id = await insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: backstopperOf(who),
      start: patch.start ?? START,
      end: patch.end ?? END,
      workDays,
      status,
      replacesId: patch.replacesId ?? null,
    });
    const debited =
      patch.replacesId === undefined &&
      (status === 'APPROVED' || status === 'REPLACED');
    const debitId = debited
      ? await insertLedger(pool, {
          kind: 'DEBIT',
          vacationId: id,
          halfDays: workDays * 2,
        })
      : null;
    return { id, debitId };
  };
  const statusOf = async (vacationId: number) =>
    (
      await pool.query(`SELECT status FROM "Vacation" WHERE id = $1`, [
        vacationId,
      ])
    ).rows[0].status;
  const ledger = async () =>
    (
      await pool.query(
        `SELECT kind, "vacationId", "refundOfId", "halfDays" FROM "LedgerEntry" ORDER BY id`,
      )
    ).rows;
  const newRequests = async (vacationId: number) =>
    (
      await pool.query(
        `SELECT "recipientId", subject, body FROM "OutboxMessage"
         WHERE type = 'NEW_REQUEST' AND "vacationId" = $1`,
        [vacationId],
      )
    ).rows;
  const mailCount = async () =>
    Number(
      (await pool.query(`SELECT count(*) AS n FROM "OutboxMessage"`)).rows[0].n,
    );

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

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §7-1
  it('без токена 401', async () => {
    const { id } = await vacation('employee1');
    const res = await request(app.getHttpServer()).post(
      `/vacations/${id}/transfer`,
    );
    expect(res.status).toBe(401);
  });

  describe('подача переноса', () => {
    // RULES §5-2, §6-6: новая заявка «На согласовании» с replacesId; остаток не меняется
    it('201: заявка-перенос PENDING с replacesId, рабочие дни считает сервер, баланс тот же', async () => {
      const { id } = await vacation('employee1');
      const res = await transfer('employee1', id, { comment: '  к морю  ' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        employee: { id: ids.employee1 },
        backstopper: { id: ids.employee2 },
        startDate: NEW_START,
        endDate: NEW_END,
        workDays: 5,
        status: 'PENDING',
        comment: 'к морю',
        replacesId: id,
        createdAt: NOW,
        transferPending: false,
        oldVacationKept: false,
        actions: ['cancel'],
      });
      expect(await statusOf(id)).toBe('APPROVED');
      expect(await balance('employee1')).toBe(32.5);
      expect(await ledger()).toHaveLength(1);
    });

    // RULES §5-2 «Комментарий необязателен»
    it('без комментария - comment null', async () => {
      const { id } = await vacation('employee1');
      const res = await transfer('employee1', id);
      expect(res.status).toBe(201);
      expect(res.body.comment).toBeNull();
    });

    // RULES §5-2 «сотрудник может выбрать другого» backstopper
    it('другой backstopper сохраняется', async () => {
      const { id } = await vacation('employee1');
      const res = await transfer('employee1', id, {
        backstopperId: ids.employee4,
      });
      expect(res.status).toBe(201);
      expect(res.body.backstopper.id).toBe(ids.employee4);
    });

    // RULES §8-2: письмо о переносе уходит согласующему как о новой заявке
    it('одно письмо NEW_REQUEST руководителю', async () => {
      const { id } = await vacation('employee1');
      const res = await transfer('employee1', id);
      const rows = await newRequests(res.body.id);
      expect(rows).toEqual([
        {
          recipientId: ids.manager1,
          subject: `Новая заявка на отпуск: Сотрудник employee1, ${NEW_START}–${NEW_END}`,
          body: expect.stringContaining(
            `подал(а) заявку на отпуск с ${NEW_START} по ${NEW_END}`,
          ),
        },
      ]);
      expect(await mailCount()).toBe(1);
    });

    // RULES §4-2, §8-2, §8-7: перенос директора - письмо HR («допуск HR»)
    it('перенос директора: письмо о заявке HR', async () => {
      const { id } = await vacation('director');
      const res = await transfer('director', id);
      expect(res.status).toBe(201);
      const rows = await newRequests(res.body.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].recipientId).toBe(ids.hr);
      expect(rows[0].subject).toBe(
        `Допуск HR: новая заявка на отпуск, Сотрудник director, ${NEW_START}–${NEW_END}`,
      );
    });

    // RULES §4-1, §8-6: перенос HR согласует заместитель директора
    it('перенос HR: письмо о заявке заместителю директора', async () => {
      const { id } = await vacation('hr');
      const res = await transfer('hr', id);
      expect(res.status).toBe(201);
      expect((await newRequests(res.body.id))[0].recipientId).toBe(ids.deputy);
    });

    // RULES §10-2: подача переноса календарь не меняет, событий нет
    it('событий шины нет', async () => {
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const { id } = await vacation('employee1');
      await transfer('employee1', id);
      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('правила новых дат', () => {
    // RULES §5-2: число рабочих дней то же
    it('другое число рабочих дней - 422 TRANSFER_WORKDAYS_MISMATCH', async () => {
      const { id } = await vacation('employee1');
      const res = await transfer('employee1', id, { endDate: '2026-11-19' });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'TRANSFER_WORKDAYS_MISMATCH',
        message: 'Число рабочих дней должно совпадать: было 5, в заявке 4',
        details: { old: 5, requested: 4 },
      });
    });

    // RULES §5-2 «Дата начала нового периода не раньше сегодняшней … начало сегодня допустимо»
    it('начало вчера - 422 TRANSFER_START_IN_PAST; начало сегодня - 201', async () => {
      const { id } = await vacation('employee1');
      const past = await transfer('employee1', id, {
        startDate: '2026-10-20',
        endDate: '2026-10-26',
      });
      expect(past.status).toBe(422);
      expect(past.body.code).toBe('TRANSFER_START_IN_PAST');
      expect(past.body.message).toBe(
        'Начало переноса не может быть раньше сегодняшней даты; для прошлых дат подайте обычную заявку',
      );
      const today = await transfer('employee1', id, {
        startDate: '2026-10-21',
        endDate: '2026-10-27',
      });
      expect(today.status).toBe(201);
    });

    // RULES §1-3, §5-2: «сегодня» по COMPANY_TZ; 2026-10-21T18:30Z = 22.10 00:30 в Бишкеке
    it('граница суток по поясу компании: 21.10 уже вчера, 22.10 сегодня', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, '2026-10-21T18:30:00.000Z');
      const yesterday = await transfer('employee1', id, {
        startDate: '2026-10-21',
        endDate: '2026-10-27',
      });
      expect(yesterday.body.code).toBe('TRANSFER_START_IN_PAST');
      const today = await transfer('employee1', id, {
        startDate: '2026-10-22',
        endDate: '2026-10-28',
      });
      expect(today.status).toBe(201);
    });

    // RULES §3-2, §3-3, §5-2: backstopper обязателен
    it.each([
      ['null', { backstopperId: null }, 'BACKSTOPPER_REQUIRED'],
      ['без поля', { backstopperId: undefined }, 'BACKSTOPPER_REQUIRED'],
      ['несуществующий', { backstopperId: 999999 }, 'BACKSTOPPER_NOT_FOUND'],
    ])('backstopper %s - 422 %s', async (_name, patch, code) => {
      const { id } = await vacation('employee1');
      const res = await transfer('employee1', id, patch);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(code);
    });

    // RULES §3-3: сам себе backstopper
    it('сам себе backstopper - 422 BACKSTOPPER_IS_SELF', async () => {
      const { id } = await vacation('employee1');
      const res = await transfer('employee1', id, {
        backstopperId: ids.employee1,
      });
      expect(res.body.code).toBe('BACKSTOPPER_IS_SELF');
    });

    // RULES §3-4, §5-2: перенос подчиняется правилам дробления
    it.each([
      ['через Новый год', '2026-12-28', '2027-01-01', 'VACATION_CROSSES_YEAR'],
      ['только выходные', '2026-11-21', '2026-11-22', 'VACATION_NO_WORK_DAYS'],
      ['начало позже окончания', NEW_END, NEW_START, 'VACATION_DATES_ORDER'],
    ])('%s - 422 %s', async (_name, startDate, endDate, code) => {
      const { id } = await vacation('employee1');
      const res = await transfer('employee1', id, { startDate, endDate });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(code);
    });

    // RULES §5-2 «старый (переносимый) отпуск не участвует»
    it('пересечение со старым отпуском допускается', async () => {
      const { id } = await vacation('employee1');
      const res = await transfer('employee1', id, {
        startDate: '2026-11-11',
        endDate: '2026-11-17',
      });
      expect(res.status).toBe(201);
    });

    // RULES §5-2, §3-4: с другими заявками сотрудника пересечение запрещено
    it.each(['APPROVED', 'PENDING'] as const)(
      'пересечение с другой заявкой %s - 422 VACATION_OVERLAP',
      async (status) => {
        const { id } = await vacation('employee1');
        const other = await vacation('employee1', {
          start: '2026-11-23',
          end: '2026-11-27',
          status,
        });
        const res = await transfer('employee1', id, {
          startDate: '2026-11-20',
          endDate: '2026-11-26',
        });
        expect(res.status).toBe(422);
        expect(res.body).toEqual({
          statusCode: 422,
          code: 'VACATION_OVERLAP',
          message:
            'У вас уже есть заявка на эти даты: с 2026-11-23 по 2026-11-27',
          details: {
            vacationId: other.id,
            from: '2026-11-23',
            to: '2026-11-27',
          },
        });
      },
    );

    // RULES §3-12, §5-2: дата выхода, начисление и остаток к переносу не применяются
    it('дата выхода сдвинута позже новых дат, остаток отрицательный - перенос принимается', async () => {
      const { id } = await vacation('employee1');
      await shiftHireDate(pool, ids.employee1, '2026-12-01');
      expect(await balance('employee1')).toBeLessThan(0);
      const res = await transfer('employee1', id);
      expect(res.status).toBe(201);
    });
  });

  describe('исходный отпуск и доступ', () => {
    // RULES §5-2, §7-2: переносит только владелец; руководитель и HR видят, но не могут
    it.each(['manager1', 'hr'] as const)(
      '%s над отпуском сотрудника - 403 FORBIDDEN',
      async (login) => {
        const { id } = await vacation('employee1');
        const res = await transfer(login, id);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      },
    );

    // RULES §7-2: невидимая и несуществующая заявка - 404
    it('невидимая, несуществующая, некорректный id - 404', async () => {
      const { id } = await vacation('employee1');
      expect((await transfer('employee4', id)).status).toBe(404);
      expect((await transfer('employee1', 999999)).status).toBe(404);
      expect((await transfer('employee1', 'abc')).status).toBe(404);
    });

    // architecture §7: workDays не принимается; DECISIONS 2026-10-28 17:06: 400 первым
    it('лишнее поле - 400 VALIDATION_FAILED раньше состояния отпуска', async () => {
      const { id } = await vacation('employee1', { status: 'REPLACED' });
      const res = await transfer('employee1', id, { workDays: 5 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    // RULES §10-1; DECISIONS 2026-10-28 17:06
    it.each(['CANCELLED', 'REPLACED'] as const)(
      'исходный %s - 409 ALREADY_PROCESSED',
      async (status) => {
        const { id } = await vacation('employee1', { status });
        const res = await transfer('employee1', id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALREADY_PROCESSED');
      },
    );

    // RULES §5-2: переносится только одобренный отпуск
    it.each(['PENDING', 'REJECTED'] as const)(
      'исходный %s - 422 TRANSFER_SOURCE_NOT_APPROVED',
      async (status) => {
        const { id } = await vacation('employee1', { status });
        const res = await transfer('employee1', id);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({
          statusCode: 422,
          code: 'TRANSFER_SOURCE_NOT_APPROVED',
          message: 'Перенести можно только одобренный отпуск',
        });
      },
    );

    // RULES §5-1, §5-9: перенос только до начала (сегодня < даты начала)
    it('накануне начала - 201; в день начала - 422 TRANSFER_STARTED', async () => {
      const a = await vacation('employee1');
      await setDbClock(pool, '2026-11-08T03:00:00.000Z');
      expect((await transfer('employee1', a.id)).status).toBe(201);

      const b = await vacation('employee2', {
        start: '2026-11-09',
        end: '2026-11-13',
      });
      await setDbClock(pool, '2026-11-09T03:00:00.000Z');
      const res = await transfer('employee2', b.id);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'TRANSFER_STARTED',
        message: 'Отпуск уже начался, перенести его нельзя',
      });
    });
  });

  describe('пока перенос ждёт решения', () => {
    /** Одобренный A и перенос B «На согласовании». */
    const withPendingTransfer = async (who: RulesOrgKey = 'employee1') => {
      const a = await vacation(who);
      const res = await transfer(who, a.id);
      expect(res.status).toBe(201);
      return { a: a.id, b: res.body.id as number };
    };

    // RULES §5-2: повторный перенос, пока первый ждёт решения
    it('второй перенос того же отпуска - 409 TRANSFER_ALREADY_PENDING', async () => {
      const { a } = await withPendingTransfer();
      const res = await transfer('employee1', a, {
        startDate: '2026-11-23',
        endDate: '2026-11-27',
      });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        statusCode: 409,
        code: 'TRANSFER_ALREADY_PENDING',
        message:
          'Перенос этого отпуска уже ждёт решения; повторно перенести отпуск нельзя',
      });
    });

    // RULES §10-1: два параллельных переноса - проходит один, письмо одно
    it('два параллельных переноса: 201 и 409, одна заявка, одно письмо', async () => {
      const { id } = await vacation('employee1');
      await token('employee1');
      const results = await Promise.all([
        transfer('employee1', id),
        transfer('employee1', id, {
          startDate: '2026-11-23',
          endDate: '2026-11-27',
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const pending = await pool.query(
        `SELECT id FROM "Vacation" WHERE "replacesId" = $1`,
        [id],
      );
      expect(pending.rows).toHaveLength(1);
      expect(await mailCount()).toBe(1);
    });

    // RULES §3-11: пометка видна владельцу, руководителю и HR
    it('у старого отпуска пометка «перенос на рассмотрении» у всех, кому он виден', async () => {
      const { a } = await withPendingTransfer();
      for (const login of ['employee1', 'manager1', 'hr'] as const) {
        const res = await get(login, `/vacations/${a}`);
        expect(res.body).toMatchObject({
          status: 'APPROVED',
          transferPending: true,
        });
      }
      const mine = (await get('employee1', '/vacations?scope=mine'))
        .body as Body[];
      expect(mine.find((v) => v.id === a)?.transferPending).toBe(true);
    });

    // RULES §5-2, §5-3: сотрудник не отменяет старый отпуск, пока перенос ждёт решения
    it('отмена старого до начала - 409 PENDING_TRANSFER_BLOCKS, возврата нет', async () => {
      const { a } = await withPendingTransfer();
      const res = await cancel('employee1', a);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        statusCode: 409,
        code: 'PENDING_TRANSFER_BLOCKS',
        message:
          'Пока перенос ждёт решения, отпуск нельзя отменить или отозвать: сначала отмените перенос',
      });
      expect(await statusOf(a)).toBe('APPROVED');
      expect(await ledger()).toHaveLength(1);
    });

    // DECISIONS 2026-10-28 15:41: PENDING_TRANSFER_BLOCKS раньше CANCEL_STARTED_BY_EMPLOYEE
    it('отмена старого в день начала - тоже PENDING_TRANSFER_BLOCKS', async () => {
      const { a } = await withPendingTransfer();
      await setDbClock(pool, '2026-11-09T03:00:00.000Z');
      const res = await cancel('employee1', a);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PENDING_TRANSFER_BLOCKS');
    });

    // RULES §5-3 «действует для всех, включая HR (в том числе отзыв из начавшегося отпуска)»
    it('отзыв HR из старого - 409 PENDING_TRANSFER_BLOCKS, и с датой вне отпуска тоже', async () => {
      const { a } = await withPendingTransfer();
      await setDbClock(pool, DURING);
      for (const returnDate of ['2026-11-12', '2026-12-01']) {
        const res = await recall('hr', a, returnDate);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PENDING_TRANSFER_BLOCKS');
      }
      expect(await statusOf(a)).toBe('APPROVED');
      expect(await ledger()).toHaveLength(1);
    });

    // RULES §5-3, §5-5: свой отпуск HR тоже не отзывается, пока перенос ждёт решения
    it('свой отпуск HR с ожидающим переносом - отзыв 409 PENDING_TRANSFER_BLOCKS', async () => {
      const { a } = await withPendingTransfer('hr');
      await setDbClock(pool, DURING);
      const res = await recall('hr', a, '2026-11-12');
      expect(res.body.code).toBe('PENDING_TRANSFER_BLOCKS');
    });

    // RULES §5-3, §3-11, §8-8: отмена переноса оставляет старый отпуск
    it('отмена переноса: «Отменена» с «Старый отпуск остаётся», старый «Одобрена», писем и событий нет', async () => {
      const { a, b } = await withPendingTransfer();
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const res = await cancel('employee1', b);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        oldVacationKept: true,
      });
      const old = await get('employee1', `/vacations/${a}`);
      expect(old.body).toMatchObject({
        status: 'APPROVED',
        transferPending: false,
        actions: ['cancel', 'transfer'],
      });
      expect(await ledger()).toHaveLength(1);
      expect(await mailCount()).toBe(1); // только NEW_REQUEST о переносе
      expect(publish).not.toHaveBeenCalled();
    });

    // RULES §5-3 «сначала отменяется перенос, затем, при необходимости, сам отпуск»
    it('после отмены переноса старый отменяется с полным возвратом', async () => {
      const { a, b } = await withPendingTransfer();
      await cancel('employee1', b);
      const res = await cancel('employee1', a);
      expect(res.status).toBe(200);
      expect(await balance('employee1')).toBe(37.5);
    });

    // RULES §5-2 (single_live_successor учитывает только PENDING и APPROVED)
    it('после отмены переноса старый можно перенести снова', async () => {
      const { a, b } = await withPendingTransfer();
      await cancel('employee1', b);
      const res = await transfer('employee1', a, {
        startDate: '2026-11-23',
        endDate: '2026-11-27',
      });
      expect(res.status).toBe(201);
    });

    // architecture §7: actions - та же проверка, что сервер
    it('actions: у старого ни отмены, ни переноса, ни отзыва; у переноса - отмена владельцу', async () => {
      const { a, b } = await withPendingTransfer();
      expect((await get('employee1', `/vacations/${a}`)).body.actions).toEqual(
        [],
      );
      expect((await get('employee1', `/vacations/${b}`)).body.actions).toEqual([
        'cancel',
      ]);
      expect((await get('manager1', `/vacations/${b}`)).body.actions).toEqual([
        'approve',
        'reject',
      ]);
      await setDbClock(pool, DURING);
      expect((await get('hr', `/vacations/${a}`)).body.actions).toEqual([]);
    });
  });

  describe('actions: transfer', () => {
    // RULES §5-1, §5-2: владельцу одобренного отпуска до начала
    it('одобренный до начала: владельцу cancel и transfer, руководителю и HR - нет', async () => {
      const { id } = await vacation('employee1');
      expect((await get('employee1', `/vacations/${id}`)).body.actions).toEqual(
        ['cancel', 'transfer'],
      );
      expect((await get('manager1', `/vacations/${id}`)).body.actions).toEqual(
        [],
      );
      expect((await get('hr', `/vacations/${id}`)).body.actions).toEqual([]);
    });

    // RULES §5-2: «На согласовании» не переносится
    it('«На согласовании»: только cancel', async () => {
      const { id } = await vacation('employee1', { status: 'PENDING' });
      expect((await get('employee1', `/vacations/${id}`)).body.actions).toEqual(
        ['cancel'],
      );
    });

    // RULES §5-1: начавшийся отпуск не переносится
    it('отпуск идёт: у владельца нет transfer', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, DURING);
      expect((await get('employee1', `/vacations/${id}`)).body.actions).toEqual(
        [],
      );
    });
  });

  describe('цепочка A→B→C (строки в БД)', () => {
    /** A и B «Заменена переносом», C «Одобрена»; списание только у корня A. */
    const chain = async () => {
      const a = await vacation('employee1', { status: 'REPLACED' });
      const b = await vacation('employee1', {
        status: 'REPLACED',
        start: NEW_START,
        end: NEW_END,
        replacesId: a.id,
      });
      const c = await vacation('employee1', {
        start: '2026-11-23',
        end: '2026-11-27',
        replacesId: b.id,
      });
      return { a: a.id, b: b.id, c: c.id, debitA: a.debitId! };
    };

    // RULES §5-12, §6-8: отмена действующего звена - возврат к списанию корня
    it('отмена C: возврат по списанию A, A и B остаются «Заменена переносом»', async () => {
      const { a, b, c, debitA } = await chain();
      expect(await balance('employee1')).toBe(32.5);
      const res = await cancel('employee1', c);
      expect(res.status).toBe(200);
      expect(await ledger()).toEqual([
        { kind: 'DEBIT', vacationId: a, refundOfId: null, halfDays: 10 },
        { kind: 'REFUND', vacationId: c, refundOfId: debitA, halfDays: 10 },
      ]);
      expect(await statusOf(a)).toBe('REPLACED');
      expect(await statusOf(b)).toBe('REPLACED');
      expect(await balance('employee1')).toBe(37.5);
    });

    // RULES §6-8, §10-1: повторная отмена второго возврата не создаёт
    it('повторная отмена C - 409 ALREADY_PROCESSED, возврат один, сумма не больше списанного', async () => {
      const { c } = await chain();
      await cancel('employee1', c);
      const again = await cancel('employee1', c);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_PROCESSED');
      const refunds = (await ledger()).filter((e) => e.kind === 'REFUND');
      expect(refunds).toHaveLength(1);
      expect(refunds[0].halfDays).toBeLessThanOrEqual(10);
    });

    // RULES §5-5, §5-6, §5-12: отзыв из C - дни с даты выхода по списанию A
    it('отзыв из C: возврат с даты выхода к списанию A', async () => {
      const { c, debitA } = await chain();
      await setDbClock(pool, '2026-11-25T03:00:00.000Z');
      const res = await recall('hr', c, '2026-11-26');
      expect(res.status).toBe(200);
      const refunds = (await ledger()).filter((e) => e.kind === 'REFUND');
      expect(refunds).toEqual([
        { kind: 'REFUND', vacationId: c, refundOfId: debitA, halfDays: 4 },
      ]);
    });

    // RULES §5-12: прежние звенья не переносятся и не отменяются
    it('перенос и отмена прежнего звена - 409 ALREADY_PROCESSED', async () => {
      const { a, b } = await chain();
      expect((await transfer('employee1', a)).body.code).toBe(
        'ALREADY_PROCESSED',
      );
      expect((await cancel('employee1', b)).body.code).toBe(
        'ALREADY_PROCESSED',
      );
    });

    // RULES §5-12: перенос уже перенесённого отпуска продолжает цепочку
    it('перенос действующего звена: новая заявка ссылается на него', async () => {
      const a = await vacation('employee1', { status: 'REPLACED' });
      const b = await vacation('employee1', {
        start: NEW_START,
        end: NEW_END,
        replacesId: a.id,
      });
      const res = await transfer('employee1', b.id, {
        startDate: '2026-11-23',
        endDate: '2026-11-27',
      });
      expect(res.status).toBe(201);
      expect(res.body.replacesId).toBe(b.id);
    });

    // RULES §5-3: ожидающий перенос среднего звена блокирует его отмену
    it('B «Одобрена» с ожидающим C: отмена B - 409 PENDING_TRANSFER_BLOCKS', async () => {
      const a = await vacation('employee1', { status: 'REPLACED' });
      const b = await vacation('employee1', {
        start: NEW_START,
        end: NEW_END,
        replacesId: a.id,
      });
      await transfer('employee1', b.id, {
        startDate: '2026-11-23',
        endDate: '2026-11-27',
      });
      const res = await cancel('employee1', b.id);
      expect(res.body.code).toBe('PENDING_TRANSFER_BLOCKS');
    });
  });
});
