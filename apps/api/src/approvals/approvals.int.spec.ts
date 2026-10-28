/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- тела ответов supertest и строки pg имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { addDays } from '../domain';
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
  truncateAll,
} from '../testing/test-db';

// Среда 2026-10-21, 09:17:42.123 по Бишкеку. Баланс employee1 (выход 2022-03-15) сегодня 37,5:
// на 1 января 2026 обрезка до 15, затем 9 начислений по 2,5 (февраль-октябрь). К ноябрьским
// датам начала добавляется начисление 1 ноября (+2,5), к декабрьским ещё 1 декабря (RULES §3-10).
const NOW = '2026-10-21T03:17:42.123Z';

type Body = Record<string, unknown>;

describe('согласование: GET /approvals, approve, reject (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;
  let tokens: Partial<Record<RulesOrgKey, string>>;

  const token = async (login: RulesOrgKey) =>
    (tokens[login] ??= await loginAs(app, login));
  // токен берётся до создания запроса: вход закрывает временный сервер supertest
  const decide = async (
    login: RulesOrgKey,
    id: number | string,
    decision: 'approve' | 'reject',
    body?: Body,
  ) => {
    const auth = bearer(await token(login));
    const req = request(app.getHttpServer())
      .post(`/vacations/${id}/${decision}`)
      .set(auth);
    return body === undefined ? req : req.send(body);
  };
  const approvals = async (login: RulesOrgKey) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer()).get('/approvals').set(auth);
  };
  const balance = async (login: RulesOrgKey, on?: string) => {
    const auth = bearer(await token(login));
    const res = await request(app.getHttpServer())
      .get(on ? `/me/balance?on=${on}` : '/me/balance')
      .set(auth);
    return res.body;
  };
  /** Заявка PENDING (или в заданном статусе), по умолчанию пн–пт 2026-11-02…06, 5 рабочих дней. */
  const vacation = (
    who: RulesOrgKey,
    patch: {
      start?: string;
      end?: string;
      workDays?: number;
      status?: 'PENDING' | 'APPROVED' | 'REJECTED';
    } = {},
  ) =>
    insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: who === 'employee2' ? ids.employee1 : ids.employee2,
      start: patch.start ?? '2026-11-02',
      end: patch.end ?? '2026-11-06',
      workDays: patch.workDays ?? 5,
      status: patch.status ?? 'PENDING',
    });
  /** Списание, после которого «баланс сегодня» employee1 равен 37,5 - halfDays/2. */
  const spend = async (halfDays: number) => {
    const v = await vacation('employee1', {
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
  const debits = async (vacationId: number) =>
    (
      await pool.query(
        `SELECT "halfDays", "occurredAt" FROM "LedgerEntry"
         WHERE kind = 'DEBIT' AND "vacationId" = $1`,
        [vacationId],
      )
    ).rows;
  const statusOf = async (vacationId: number) =>
    (
      await pool.query(`SELECT status FROM "Vacation" WHERE id = $1`, [
        vacationId,
      ])
    ).rows[0].status;

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
    const id = await vacation('employee1');
    const server = app.getHttpServer();
    expect((await request(server).get('/approvals')).status).toBe(401);
    expect(
      (await request(server).post(`/vacations/${id}/approve`)).status,
    ).toBe(401);
    expect((await request(server).post(`/vacations/${id}/reject`)).status).toBe(
      401,
    );
  });

  describe('подтверждение', () => {
    // RULES §4-1, §4-4, §6-6: «Одобрена», одно списание всего отпуска, момент по Clock
    it('руководитель подтверждает: статус, решение, одно списание, остаток уменьшился', async () => {
      const id = await vacation('employee1');
      expect((await balance('employee1')).balance).toBe(37.5);

      const res = await decide('manager1', id, 'approve', {
        comment: '  хорошего отдыха  ',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id,
        status: 'APPROVED',
        decidedBy: { id: ids.manager1, fullName: expect.any(String) },
        decidedAt: NOW,
        decisionComment: 'хорошего отдыха',
        actions: [],
      });
      expect(res.body.employee).toEqual({
        id: ids.employee1,
        fullName: expect.any(String),
      });
      const rows = await debits(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].halfDays).toBe(10);
      expect(rows[0].occurredAt.toISOString()).toBe(NOW);
      expect((await balance('employee1')).balance).toBe(32.5);
    });

    // RULES §4-2: заявку директора подтверждает HR («допуск HR»), дни списываются
    it('HR подтверждает заявку директора', async () => {
      const id = await vacation('director');
      const res = await decide('hr', id, 'approve');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APPROVED');
      expect(await debits(id)).toHaveLength(1);
    });

    // RULES §4-1: заявку HR согласует заместитель директора
    it('заместитель подтверждает заявку HR', async () => {
      const id = await vacation('hr');
      const res = await decide('deputy', id, 'approve');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APPROVED');
    });

    // RULES §4-5: заявка «На согласовании» после даты начала согласуется задним числом
    it('после даты начала подтверждается задним числом', async () => {
      const id = await vacation('employee1', {
        start: '2026-10-12',
        end: '2026-10-16',
      });
      const res = await decide('manager1', id, 'approve');
      expect(res.status).toBe(200);
      expect(await debits(id)).toHaveLength(1);
    });

    // RULES §4-4, §2-5, §6-6: январская заявка, одобренная в декабре, списывается сразу;
    // обрезка 1 января считается от остатка с учётом этого списания
    it('январская заявка, одобренная в декабре: обрезка 1 января после списания', async () => {
      await setDbClock(pool, '2026-12-10T03:00:00Z');
      const id = await vacation('employee1', {
        start: '2027-01-11',
        end: '2027-01-15',
      });
      expect((await balance('employee1')).balance).toBe(42.5);

      expect((await decide('manager1', id, 'approve')).status).toBe(200);
      expect((await balance('employee1')).balance).toBe(37.5);

      // 1 января: 37,5 + 2,5 = 40 → обрезка до 15; списание уже до обрезки, повторно не вычитается
      await setDbClock(pool, '2027-01-05T03:00:00Z');
      expect((await balance('employee1')).balance).toBe(15);
    });

    // RULES §4-3; DECISIONS 2026-10-26 10:47: нехватка дней блокирует, заявка остаётся PENDING
    it('не хватает дней: 422 с «осталось X дней, в заявке Y», статус и журнал не меняются', async () => {
      await spend(75); // сегодня 0, на 2026-11-02: 2,5
      const id = await vacation('employee1');
      const res = await decide('manager1', id, 'approve');
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'APPROVE_INSUFFICIENT_BALANCE',
        message: 'Согласовать нельзя: осталось 2,5 дней, в заявке 5',
        details: { available: 2.5, requested: 5 },
      });
      expect(await statusOf(id)).toBe('PENDING');
      expect(await debits(id)).toHaveLength(0);

      // RULES §4-3: отклонить можно
      const rejected = await decide('manager1', id, 'reject');
      expect(rejected.status).toBe(200);
      expect(rejected.body.status).toBe('REJECTED');
    });

    // RULES §4-3, §6-4: после сдвига даты выхода остаток отрицательный, минус типографский
    it('отрицательный остаток: текст с типографским минусом', async () => {
      await spend(82); // сегодня −3,5, на 2026-11-02: −1
      const id = await vacation('employee1');
      const res = await decide('manager1', id, 'approve');
      expect(res.status).toBe(422);
      expect(res.body.message).toBe(
        'Согласовать нельзя: осталось −1 дней, в заявке 5',
      );
      expect(res.body.details).toEqual({ available: -1, requested: 5 });
    });

    // RULES §4-3, §3-10: проверка повторная - после одобрения другой заявки дней уже не хватает
    it('при подаче хватало, после одобрения другой заявки согласовать нельзя', async () => {
      await spend(65); // сегодня 5, на ноябрь 7,5: каждой заявке по отдельности хватает
      const first = await vacation('employee1');
      const second = await vacation('employee1', {
        start: '2026-11-16',
        end: '2026-11-20',
      });
      expect((await decide('manager1', first, 'approve')).status).toBe(200);
      const res = await decide('manager1', second, 'approve');
      expect(res.status).toBe(422);
      expect(res.body.details).toEqual({ available: 2.5, requested: 5 });
    });

    // RULES §3-10: «доступно на дату начала» учитывает начисления до даты начала
    it('остаток проверяется на дату начала, а не на сегодня', async () => {
      await spend(75); // сегодня 0; к 2026-12-07: +2,5 (1 ноября) +2,5 (1 декабря) = 5
      const id = await vacation('employee1', {
        start: '2026-12-07',
        end: '2026-12-11',
      });
      expect((await decide('manager1', id, 'approve')).status).toBe(200);
    });
  });

  describe('отклонение', () => {
    // RULES §4-1: отклонить с необязательным комментарием; дни не списываются
    it('руководитель отклоняет: «Отклонена», без списания', async () => {
      const id = await vacation('employee1');
      const res = await decide('manager1', id, 'reject', {
        comment: 'не в этот раз',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        decidedBy: { id: ids.manager1 },
        decidedAt: NOW,
        decisionComment: 'не в этот раз',
      });
      expect(await debits(id)).toHaveLength(0);
      expect((await balance('employee1')).balance).toBe(37.5);
    });

    // RULES §4-5, §5-12: заявку «На согласовании» после начала можно отклонить
    it('после даты начала отклоняется', async () => {
      const id = await vacation('employee1', {
        start: '2026-10-12',
        end: '2026-10-16',
      });
      const res = await decide('manager1', id, 'reject');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('REJECTED');
    });
  });

  describe('тело решения', () => {
    // RULES §4-1: комментарий необязателен
    it.each([
      ['без тела', undefined],
      ['пустой объект', {}],
      ['comment: null', { comment: null }],
      ['пробелы', { comment: '   ' }],
    ])('%s: 200, decisionComment = null', async (_, body) => {
      const id = await vacation('employee1');
      const res = await decide('manager1', id, 'approve', body);
      expect(res.status).toBe(200);
      expect(res.body.decisionComment).toBeNull();
    });

    // RULES §4-1: в теле только comment; остальное - 400
    it.each([
      ['лишнее поле', { comment: 'ок', status: 'APPROVED' }],
      ['comment не строка', { comment: 5 }],
    ])('%s: 400 VALIDATION_FAILED, заявка не тронута', async (_, body) => {
      const id = await vacation('employee1');
      const res = await decide('manager1', id, 'approve', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await statusOf(id)).toBe('PENDING');
    });
  });

  describe('доступ и порядок ошибок', () => {
    // RULES §7-2: невидимая, несуществующая и некорректная заявка - 404
    it.each(['999999', 'abc', '0', '-1', '1.5'])(
      'id %s: 404 NOT_FOUND',
      async (raw) => {
        await vacation('employee1');
        const res = await decide('manager1', raw, 'approve');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      },
    );

    // RULES §7-2, §7-3: руководитель 2 заявку команды 1 не видит; заместитель - заявку сотрудника
    it.each<[RulesOrgKey, RulesOrgKey]>([
      ['manager2', 'employee1'],
      ['deputy', 'employee1'],
      ['employee2', 'employee1'],
      ['deputy', 'director'],
    ])('%s по заявке %s: 404', async (actor, author) => {
      const id = await vacation(author);
      for (const decision of ['approve', 'reject'] as const) {
        const res = await decide(actor, id, decision);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      expect(await statusOf(id)).toBe('PENDING');
    });

    // RULES §4-1, §4-2; DECISIONS 2026-10-22 12:15: свою заявку не согласует никто
    it.each<RulesOrgKey>(['employee1', 'manager1', 'hr', 'deputy'])(
      '%s по своей заявке: 403 APPROVE_OWN_REQUEST',
      async (author) => {
        const id = await vacation(author);
        for (const decision of ['approve', 'reject'] as const) {
          const res = await decide(author, id, decision);
          expect(res.status).toBe(403);
          expect(res.body).toEqual({
            statusCode: 403,
            code: 'APPROVE_OWN_REQUEST',
            message: 'Свою заявку согласовать нельзя',
          });
        }
        expect(await statusOf(id)).toBe('PENDING');
      },
    );

    // RULES §4-2: HR видит все заявки, но согласует только заявки директора
    it('HR по заявке сотрудника: 403 NOT_APPROVER', async () => {
      const id = await vacation('employee1');
      const res = await decide('hr', id, 'approve');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        statusCode: 403,
        code: 'NOT_APPROVER',
        message: 'Эту заявку согласует другой сотрудник',
      });
    });

    // RULES §4-1: заявки заместителя согласует директор
    it('директор подтверждает заявку заместителя', async () => {
      const deputyRequest = await vacation('deputy');
      expect((await decide('director', deputyRequest, 'approve')).status).toBe(
        200,
      );
    });

    // RULES §10-1; architecture §8: повторное решение - 409 «уже обработана»
    it.each([
      ['approve', 'approve'],
      ['approve', 'reject'],
      ['reject', 'reject'],
      ['reject', 'approve'],
    ] as const)(
      '%s, затем %s: 409 ALREADY_PROCESSED',
      async (first, second) => {
        const id = await vacation('employee1');
        expect((await decide('manager1', id, first)).status).toBe(200);
        const res = await decide('manager1', id, second);
        expect(res.status).toBe(409);
        expect(res.body).toEqual({
          statusCode: 409,
          code: 'ALREADY_PROCESSED',
          message: 'Заявка уже обработана',
        });
        expect(await debits(id)).toHaveLength(first === 'approve' ? 1 : 0);
      },
    );

    // architecture §8: 403 раньше 409
    it('HR по уже одобренной заявке сотрудника: 403, а не 409', async () => {
      const id = await vacation('employee1', { status: 'APPROVED' });
      const res = await decide('hr', id, 'approve');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_APPROVER');
    });

    // architecture §8: 409 раньше 422
    it('уже отклонённая заявка при нехватке дней: 409, а не 422', async () => {
      await spend(75);
      const id = await vacation('employee1', { status: 'REJECTED' });
      const res = await decide('manager1', id, 'approve');
      expect(res.status).toBe(409);
    });

    // RULES §10-1; architecture §6 п.5: БД запрещает второе списание - ответ 409, а не 500
    it('списание по заявке уже есть в журнале: 409, статус не меняется', async () => {
      const id = await vacation('employee1');
      await insertLedger(pool, { kind: 'DEBIT', vacationId: id, halfDays: 10 });
      const res = await decide('manager1', id, 'approve');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ALREADY_PROCESSED');
      expect(await statusOf(id)).toBe('PENDING');
      expect(await debits(id)).toHaveLength(1);
    });
  });

  describe('GET /approvals', () => {
    // RULES §4-7: заявки PENDING прямых подчинённых; чужие команды и другие статусы не видны
    it('руководитель видит PENDING только своих прямых подчинённых, по id', async () => {
      const e2 = await vacation('employee2');
      const e1 = await vacation('employee1');
      await vacation('employee3', { status: 'APPROVED' });
      await vacation('employee4'); // команда 2
      await vacation('manager1'); // своя заявка - у заместителя

      const res = await approvals('manager1');
      expect(res.status).toBe(200);
      expect(res.body.map((i: Body) => (i.vacation as Body).id)).toEqual([
        e2,
        e1,
      ]);
      expect(res.body[0].vacation.actions).toEqual(['approve', 'reject']);
      expect(res.body[0].vacation.employee).toEqual({
        id: ids.employee2,
        fullName: expect.any(String),
      });
    });

    // RULES §4-2, §4-7: HR видит здесь только заявки директора
    it('HR видит только заявки директора', async () => {
      const d = await vacation('director');
      await vacation('employee1');
      await vacation('deputy');
      const res = await approvals('hr');
      expect(res.status).toBe(200);
      expect(res.body.map((i: Body) => (i.vacation as Body).id)).toEqual([d]);
    });

    // RULES §4-1: заместитель согласует HR и руководителей
    it('заместитель видит заявки HR и руководителей', async () => {
      const h = await vacation('hr');
      const m = await vacation('manager1');
      await vacation('employee1');
      const res = await approvals('deputy');
      expect(res.body.map((i: Body) => (i.vacation as Body).id)).toEqual([
        h,
        m,
      ]);
    });

    // RULES §4-7; architecture §7: без подчинённых и не HR - 403
    it.each<RulesOrgKey>(['employee1', 'employee4'])('%s: 403', async (who) => {
      const res = await approvals(who);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('пустая очередь: 200 и []', async () => {
      const res = await approvals('manager2');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    // RULES §4-7, §3-10: остаток «доступно на дату начала» тем же кодом, что /me/balance
    it('availableOnStart совпадает с /me/balance?on=начало, canApprove true', async () => {
      await spend(75);
      await vacation('employee1', { start: '2026-12-07', end: '2026-12-11' });
      const forecast = await balance('employee1', '2026-12-07');
      const [item] = (await approvals('manager1')).body;
      expect(item.availableOnStart).toBe(forecast.availableOn);
      expect(item.availableOnStart).toBe(5);
      expect(item.canApprove).toBe(true);
      expect(item.blockReason).toBeNull();
    });

    // RULES §4-3: руководитель видит причину до нажатия
    it('нехватка дней: canApprove false и blockReason как ответ approve', async () => {
      await spend(75);
      const id = await vacation('employee1');
      const [item] = (await approvals('manager1')).body;
      const refused = await decide('manager1', id, 'approve');
      expect(item.canApprove).toBe(false);
      expect(item.blockReason).toEqual(refused.body);
    });
  });

  describe('предупреждение о пересечениях (RULES §4-6)', () => {
    // RULES §4-6: одобренные отпуска прямых подчинённых и самого руководителя; PENDING и чужие - нет
    it('руководитель: подчинённые и он сам, только «Одобрена»', async () => {
      const target = await vacation('employee1', {
        start: '2026-11-09',
        end: '2026-11-13',
      });
      const own = await vacation('manager1', {
        start: '2026-11-02',
        end: '2026-11-09',
        status: 'APPROVED',
      });
      const colleague = await vacation('employee2', {
        start: '2026-11-12',
        end: '2026-11-20',
        status: 'APPROVED',
      });
      await vacation('employee3', {
        start: '2026-11-09',
        end: '2026-11-13',
      }); // PENDING
      await vacation('employee3', {
        start: '2026-11-10',
        end: '2026-11-11',
        status: 'REJECTED',
      });
      await vacation('employee4', {
        start: '2026-11-09',
        end: '2026-11-13',
        status: 'APPROVED',
      }); // команда 2
      await vacation('employee3', {
        start: '2026-11-16',
        end: '2026-11-20',
        status: 'APPROVED',
      }); // команда 1, даты не пересекаются
      const items = (await approvals('manager1')).body;
      const item = items.find((i: Body) => (i.vacation as Body).id === target);
      expect(item.overlaps).toEqual([
        {
          vacationId: own,
          employee: { id: ids.manager1, fullName: expect.any(String) },
          startDate: '2026-11-02',
          endDate: '2026-11-09',
        },
        {
          vacationId: colleague,
          employee: { id: ids.employee2, fullName: expect.any(String) },
          startDate: '2026-11-12',
          endDate: '2026-11-20',
        },
      ]);
      // RULES §4-6: согласование не блокируется
      expect(item.canApprove).toBe(true);
      expect((await decide('manager1', target, 'approve')).status).toBe(200);
    });

    // RULES §4-6; DECISIONS 2026-10-22 12:15: допуск HR - прямые подчинённые директора и он сам
    it('HR по заявке директора: команда директора, не команда HR', async () => {
      const target = await vacation('director', {
        start: '2026-11-09',
        end: '2026-11-13',
      });
      const deputyVacation = await vacation('deputy', {
        start: '2026-11-11',
        end: '2026-11-17',
        status: 'APPROVED',
      });
      await vacation('hr', {
        start: '2026-11-09',
        end: '2026-11-13',
        status: 'APPROVED',
      });
      await vacation('manager1', {
        start: '2026-11-09',
        end: '2026-11-13',
        status: 'APPROVED',
      });
      const [item] = (await approvals('hr')).body;
      expect(item.vacation.id).toBe(target);
      expect(item.overlaps.map((o: Body) => o.vacationId as number)).toEqual([
        deputyVacation,
      ]);
    });
  });

  describe('actions в списках заявок', () => {
    // architecture §7: подсказка кнопок по зрителю; автору approve/reject не показываются,
    // а до начала доступна отмена (RULES §5-4, S6-a)
    it('руководителю approve/reject у PENDING подчинённого, автору - только cancel', async () => {
      await vacation('employee1');
      const auth = bearer(await token('manager1'));
      const team = await request(app.getHttpServer())
        .get('/vacations?scope=team')
        .set(auth);
      expect(team.body[0].actions).toEqual(['approve', 'reject']);
      expect(team.body[0].employee).not.toHaveProperty('managerId');

      const own = bearer(await token('employee1'));
      const mine = await request(app.getHttpServer())
        .get('/vacations?scope=mine')
        .set(own);
      expect(mine.body[0].actions).toEqual(['cancel']);
    });
  });

  describe('событие vacation.approved (RULES §10-2)', () => {
    // architecture §4, §9: публикуется после коммита, ровно одно, только при одобрении
    it('одобрение: одно событие с идентификаторами', async () => {
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const id = await vacation('employee1');
      await decide('manager1', id, 'approve');
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith({
        type: 'vacation.approved',
        employeeId: ids.employee1,
        vacationId: id,
      });
    });

    it('отклонение, 409 и 422: событий нет', async () => {
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const rejected = await vacation('employee1');
      await decide('manager1', rejected, 'reject');
      await decide('manager1', rejected, 'approve'); // 409
      await spend(75); // на 2026-11-16: 2,5
      const short = await vacation('employee1', {
        start: '2026-11-16',
        end: '2026-11-20',
      });
      expect((await decide('manager1', short, 'approve')).status).toBe(422);
      expect(publish).not.toHaveBeenCalled();
    });

    // architecture §4: сбой подписчика после коммита не меняет ответ
    it('подписчик упал: ответ 200, заявка одобрена', async () => {
      const bus = app.get(EventBus);
      const unsubscribe = bus.subscribe(() => {
        throw new Error('подписчик упал');
      });
      try {
        const id = await vacation('employee1');
        const res = await decide('manager1', id, 'approve');
        expect(res.status).toBe(200);
        expect(await statusOf(id)).toBe('APPROVED');
      } finally {
        unsubscribe();
      }
    });
  });

  describe('конкурентность (RULES §10-1)', () => {
    // RULES §10-1: двойной клик - одно решение, одно списание, одно событие
    it('два параллельных approve: 200 и 409, одно списание', async () => {
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const id = await vacation('employee1');
      await token('manager1');
      const results = await Promise.all([
        decide('manager1', id, 'approve'),
        decide('manager1', id, 'approve'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await debits(id)).toHaveLength(1);
      expect(publish).toHaveBeenCalledTimes(1);
    });

    // RULES §10-1: approve и reject одновременно - проходит одно, статус соответствует журналу
    it('параллельные approve и reject: одно решение, статус согласован с журналом', async () => {
      for (let i = 0; i < 5; i += 1) {
        const start = addDays('2026-11-02', i * 7);
        const id = await vacation('employee1', {
          start,
          end: addDays(start, 4),
        });
        await token('manager1');
        const results = await Promise.all([
          decide('manager1', id, 'approve'),
          decide('manager1', id, 'reject'),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const status = await statusOf(id);
        expect(await debits(id)).toHaveLength(status === 'APPROVED' ? 1 : 0);
      }
    });

    // RULES §10-1, §4-3: остаток читается под блокировкой сотрудника - дней хватает на одну
    it('две заявки одного сотрудника, дней на одну: одна 200, другая 422', async () => {
      await spend(65); // на ноябрь 7,5
      const a = await vacation('employee1');
      const b = await vacation('employee1', {
        start: '2026-11-16',
        end: '2026-11-20',
      });
      await token('manager1');
      const results = await Promise.all([
        decide('manager1', a, 'approve'),
        decide('manager1', b, 'approve'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect((await balance('employee1')).balance).toBe(0);
    });
  });
});
