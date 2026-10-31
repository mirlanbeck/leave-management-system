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
  truncateAll,
} from '../testing/test-db';

// Среда 2026-10-21, 09:17:42.123 по Бишкеку. Баланс employee1 (выход 2022-03-15) сегодня 37,5
// (как в approvals.int.spec). Отпуск по умолчанию пн 2026-11-09 – пт 2026-11-13, 5 рабочих дней.
const NOW = '2026-10-21T03:17:42.123Z';
// Среда 2026-11-11, 09:00 по Бишкеку: отпуск идёт
const DURING = '2026-11-11T03:00:00.000Z';
const START = '2026-11-09';
const END = '2026-11-13';

type Body = Record<string, unknown>;
type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

describe('отмена и отзыв: POST /vacations/{id}/cancel и /recall (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;
  let tokens: Partial<Record<RulesOrgKey, string>>;

  const token = async (login: RulesOrgKey) =>
    (tokens[login] ??= await loginAs(app, login));
  // токен берётся до создания запроса: вход закрывает временный сервер supertest
  const post = async (
    login: RulesOrgKey,
    id: number | string,
    action: 'cancel' | 'recall',
    body?: Body,
  ) => {
    const auth = bearer(await token(login));
    const req = request(app.getHttpServer())
      .post(`/vacations/${id}/${action}`)
      .set(auth);
    return body === undefined ? req : req.send(body);
  };
  const cancel = (login: RulesOrgKey, id: number | string, body?: Body) =>
    post(login, id, 'cancel', body);
  const recall = (
    login: RulesOrgKey,
    id: number | string,
    returnDate?: string,
  ) =>
    post(login, id, 'recall', returnDate === undefined ? {} : { returnDate });
  const get = async (login: RulesOrgKey, path: string) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer()).get(path).set(auth);
  };
  const balance = async (login: RulesOrgKey) =>
    (await get(login, '/me/balance')).body.balance;

  /** Заявка в статусе; у «Одобрена» - списание всех рабочих дней, как при согласовании. */
  const vacation = async (
    who: RulesOrgKey,
    patch: {
      start?: string;
      end?: string;
      workDays?: number;
      status?: Status;
    } = {},
  ) => {
    const status = patch.status ?? 'APPROVED';
    const workDays = patch.workDays ?? 5;
    const id = await insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: who === 'employee2' ? ids.employee1 : ids.employee2,
      start: patch.start ?? START,
      end: patch.end ?? END,
      workDays,
      status,
    });
    const debitId =
      status === 'APPROVED'
        ? await insertLedger(pool, {
            kind: 'DEBIT',
            vacationId: id,
            halfDays: workDays * 2,
          })
        : null;
    return { id, debitId };
  };
  const refunds = async (vacationId: number) =>
    (
      await pool.query(
        `SELECT "vacationId", "refundOfId", "halfDays", "occurredAt" FROM "LedgerEntry"
         WHERE kind = 'REFUND' AND "vacationId" = $1`,
        [vacationId],
      )
    ).rows;
  const statusOf = async (vacationId: number) =>
    (
      await pool.query(`SELECT status FROM "Vacation" WHERE id = $1`, [
        vacationId,
      ])
    ).rows[0].status;
  const mails = async () =>
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
    const server = app.getHttpServer();
    expect((await request(server).post(`/vacations/${id}/cancel`)).status).toBe(
      401,
    );
    expect((await request(server).post(`/vacations/${id}/recall`)).status).toBe(
      401,
    );
  });

  describe('отмена владельцем до начала', () => {
    // RULES §5-4, §6-6, §6-8: «Одобрена» → «Отменена», возврат всех дней к списанию, момент по Clock
    it('одобренный отпуск: статус «Отменена», полный возврат, остаток восстановлен', async () => {
      const { id, debitId } = await vacation('employee1');
      expect(await balance('employee1')).toBe(32.5);

      const res = await cancel('employee1', id);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id,
        status: 'CANCELLED',
        cancelledAt: NOW,
        returnDate: null,
        actions: [],
      });
      expect(await refunds(id)).toEqual([
        {
          vacationId: id,
          refundOfId: debitId,
          halfDays: 10,
          occurredAt: new Date(NOW),
        },
      ]);
      expect(await balance('employee1')).toBe(37.5);
    });

    // RULES §5-4: у «На согласовании» дней не списывали - возвращать нечего
    it('заявка «На согласовании»: «Отменена» без возврата и без события', async () => {
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const { id } = await vacation('employee1', { status: 'PENDING' });

      const res = await cancel('employee1', id);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(await refunds(id)).toEqual([]);
      expect(await balance('employee1')).toBe(37.5);
      expect(publish).not.toHaveBeenCalled();
    });

    // RULES §5-4, §5-10 (DECISIONS 2026-10-28 15:41): свой отпуск HR отменяет как сотрудник
    it('HR отменяет свой одобренный отпуск до начала', async () => {
      const { id } = await vacation('hr');
      const res = await cancel('hr', id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(await refunds(id)).toHaveLength(1);
    });

    // RULES §5-9, §1-3: «сегодня» по поясу компании; накануне до полуночи по Бишкеку ещё можно
    it('граница начала по Asia/Bishkek: 23:59:59 накануне - можно, 00:00 дня начала - нельзя', async () => {
      const before = await vacation('employee1');
      await setDbClock(pool, '2026-11-08T17:59:59.000Z'); // 08.11 23:59:59 по Бишкеку
      expect((await cancel('employee1', before.id)).status).toBe(200);

      const after = await vacation('employee1', {
        start: '2026-11-16',
        end: '2026-11-20',
      });
      await setDbClock(pool, '2026-11-15T18:00:00.000Z'); // 16.11 00:00 по Бишкеку
      const res = await cancel('employee1', after.id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CANCEL_STARTED_BY_EMPLOYEE');
    });
  });

  describe('отказы отмены', () => {
    // RULES §5-7: после начала сотрудник сам не отменяет; ничего не меняется
    it('сотрудник после начала - 403 CANCEL_STARTED_BY_EMPLOYEE', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, DURING);
      const res = await cancel('employee1', id);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        statusCode: 403,
        code: 'CANCEL_STARTED_BY_EMPLOYEE',
        message: 'Отпуск уже начался: отменить его сами вы не можете',
      });
      expect(await statusOf(id)).toBe('APPROVED');
      expect(await refunds(id)).toEqual([]);
    });

    // RULES §5-10: «На согласовании» после начала не отменяет никто
    it('«На согласовании» после начала - 422 CANCEL_PENDING_AFTER_START', async () => {
      const { id } = await vacation('employee1', { status: 'PENDING' });
      await setDbClock(pool, DURING);
      const res = await cancel('employee1', id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CANCEL_PENDING_AFTER_START');
      expect(await statusOf(id)).toBe('PENDING');
    });

    // RULES §5-10: HR до начала чужой отпуск не отменяет; руководитель тоже (§7-2)
    it.each(['hr', 'manager1'] as const)(
      '%s отменяет отпуск employee1 до начала - 403 FORBIDDEN',
      async (actor) => {
        const { id } = await vacation('employee1');
        const res = await cancel(actor, id);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
        expect(await statusOf(id)).toBe('APPROVED');
      },
    );

    // RULES §7-2: чужая невидимая заявка, несуществующая и некорректный id - 404
    it('невидимая, несуществующая, некорректный id - 404', async () => {
      const { id } = await vacation('employee1');
      expect((await cancel('manager2', id)).status).toBe(404);
      expect((await cancel('employee1', 999999)).status).toBe(404);
      expect((await cancel('employee1', 'abc')).status).toBe(404);
    });

    // architecture §7: тело отмены пустое
    it('лишнее поле в теле - 400 VALIDATION_FAILED', async () => {
      const { id } = await vacation('employee1');
      const res = await cancel('employee1', id, { reason: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    // RULES §10-1: «Отклонена» и «Отменена» - уже обработана
    it.each(['REJECTED', 'CANCELLED'] as const)(
      'статус %s - 409 ALREADY_PROCESSED',
      async (status) => {
        const { id } = await vacation('employee1', { status });
        const res = await cancel('employee1', id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALREADY_PROCESSED');
      },
    );
  });

  describe('отзыв HR из идущего отпуска', () => {
    // RULES §5-5, §5-6, §5-11: выход на дату начала - все дни; день выхода рабочий
    it.each([
      [START, 10, 'дата начала: все 5 дней'],
      ['2026-11-12', 4, 'середина: 12 и 13 ноября'],
      [END, 2, 'дата окончания: 1 день'],
    ])(
      'дата выхода %s возвращает %i полудней (%s)',
      async (returnDate, halfDays) => {
        const { id, debitId } = await vacation('employee1');
        await setDbClock(pool, DURING);
        const before = await balance('employee1');

        const res = await recall('hr', id, returnDate);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          id,
          status: 'CANCELLED',
          returnDate,
          cancelledAt: DURING,
        });
        // RULES §6-6: возврат датируется по Clock в момент действия, а не датой выхода
        expect(await refunds(id)).toEqual([
          {
            vacationId: id,
            refundOfId: debitId,
            halfDays,
            occurredAt: new Date(DURING),
          },
        ]);
        expect(await balance('employee1')).toBe(before + halfDays / 2);
      },
    );

    // RULES §5-11 (DECISIONS 2026-10-22 15:35): дата выхода раньше и позже сегодня в пределах отпуска
    it('дата выхода раньше сегодня и позже сегодня принимаются', async () => {
      const past = await vacation('employee1');
      await setDbClock(pool, DURING);
      expect((await recall('hr', past.id, '2026-11-10')).status).toBe(200);

      const future = await vacation('employee2');
      expect((await recall('hr', future.id, '2026-11-13')).status).toBe(200);
    });

    // RULES §5-6: выход в выходной в конце отпуска возвращает 0 дней
    it('выход в субботу у отпуска пн–вс - возврат 0', async () => {
      const { id } = await vacation('employee1', { end: '2026-11-15' });
      await setDbClock(pool, DURING);
      expect((await recall('hr', id, '2026-11-14')).status).toBe(200);
      expect((await refunds(id))[0].halfDays).toBe(0);
    });

    // RULES §5-5 (DECISIONS 2026-10-28 15:41): в день окончания отзыв ещё возможен
    it('сегодня = дата окончания - можно', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, '2026-11-13T03:00:00.000Z');
      expect((await recall('hr', id, END)).status).toBe(200);
    });

    // RULES §5-5 (DECISIONS 2026-10-28 15:41): HR отзывает и себя
    it('HR отзывает себя из своего отпуска', async () => {
      const { id } = await vacation('hr');
      await setDbClock(pool, DURING);
      const res = await recall('hr', id, '2026-11-12');
      expect(res.status).toBe(200);
      expect(await refunds(id)).toHaveLength(1);
    });

    // RULES §5-5, §7-2: HR действует над всей компанией, в том числе над директором
    it('HR отзывает директора', async () => {
      const { id } = await vacation('director');
      await setDbClock(pool, DURING);
      expect((await recall('hr', id, '2026-11-12')).status).toBe(200);
    });
  });

  describe('отказы отзыва', () => {
    // RULES §5-11: дата после окончания не является отзывом; раньше начала - тоже вне отпуска
    it.each(['2026-11-14', '2026-11-06'])(
      'дата выхода %s вне отпуска - 422 RECALL_DATE_OUT_OF_RANGE',
      async (returnDate) => {
        const { id } = await vacation('employee1');
        await setDbClock(pool, DURING);
        const res = await recall('hr', id, returnDate);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('RECALL_DATE_OUT_OF_RANGE');
        expect(await statusOf(id)).toBe('APPROVED');
        expect(await refunds(id)).toEqual([]);
      },
    );

    // RULES §5-4, §5-10: до начала HR не отменяет и не отзывает
    it('до начала - 422 RECALL_NOT_STARTED', async () => {
      const { id } = await vacation('employee1');
      const res = await recall('hr', id, START);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('RECALL_NOT_STARTED');
    });

    // RULES §5-5 (DECISIONS 2026-10-28 15:41): из завершённого отпуска отзыва нет
    it('на следующий день после окончания - 422 RECALL_FINISHED', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, '2026-11-14T03:00:00.000Z');
      const res = await recall('hr', id, END);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'RECALL_FINISHED',
        message: 'Отпуск уже закончился: отозвать из него нельзя',
      });
    });

    // RULES §5-5, §5-10: «На согласовании» после начала не отзывается
    it('«На согласовании» после начала - 422 RECALL_NOT_APPROVED', async () => {
      const { id } = await vacation('employee1', { status: 'PENDING' });
      await setDbClock(pool, DURING);
      const res = await recall('hr', id, START);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('RECALL_NOT_APPROVED');
    });

    // RULES §5-5, §7-2: отзывает только HR; невидимое - 404
    it('руководитель и сам сотрудник - 403, невидимый - 404', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, DURING);
      expect((await recall('manager1', id, START)).status).toBe(403);
      expect((await recall('employee1', id, START)).status).toBe(403);
      expect((await recall('manager2', id, START)).status).toBe(404);
      expect(await statusOf(id)).toBe('APPROVED');
    });

    // architecture §7: дата выхода обязательна, формат YYYY-MM-DD
    it.each([undefined, '2026-11-31', '11.11.2026'])(
      'дата выхода %s - 400 VALIDATION_FAILED',
      async (returnDate) => {
        const { id } = await vacation('employee1');
        await setDbClock(pool, DURING);
        const res = await recall('hr', id, returnDate);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.body.details.fields).toHaveProperty('returnDate');
      },
    );
  });

  describe('повтор и конкурентность (RULES §10-1, §6-8)', () => {
    it('повторная отмена - 409 «уже обработана», второго возврата нет', async () => {
      const { id } = await vacation('employee1');
      expect((await cancel('employee1', id)).status).toBe(200);
      const again = await cancel('employee1', id);
      expect(again.status).toBe(409);
      expect(again.body.message).toBe('Заявка уже обработана');
      expect(await refunds(id)).toHaveLength(1);
      expect(await balance('employee1')).toBe(37.5);
    });

    it('повторный отзыв - 409, один возврат', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, DURING);
      expect((await recall('hr', id, '2026-11-12')).status).toBe(200);
      expect((await recall('hr', id, START)).status).toBe(409);
      expect(await refunds(id)).toHaveLength(1);
    });

    it('две параллельные отмены: 200 и 409, один возврат, одно событие', async () => {
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const { id } = await vacation('employee1');
      await token('employee1');
      const results = await Promise.all([
        cancel('employee1', id),
        cancel('employee1', id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await refunds(id)).toHaveLength(1);
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it('два параллельных отзыва: 200 и 409, один возврат', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, DURING);
      await token('hr');
      const results = await Promise.all([
        recall('hr', id, START),
        recall('hr', id, END),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await refunds(id)).toHaveLength(1);
    });
  });

  describe('письма и события', () => {
    // RULES §8-8: отмена и отзыв писем не порождают
    it('отмена одобренного, отмена заявки и отзыв: писем нет', async () => {
      const approved = await vacation('employee1');
      const pending = await vacation('employee1', {
        status: 'PENDING',
        start: '2026-11-23',
        end: '2026-11-27',
      });
      await cancel('employee1', approved.id);
      await cancel('employee1', pending.id);
      const started = await vacation('employee2');
      await setDbClock(pool, DURING);
      expect((await recall('hr', started.id, END)).status).toBe(200);
      expect(await mails()).toBe(0);
    });

    // RULES §7-2, §10-2; architecture §9: событие после коммита, только идентификаторы;
    // отмена и отзыв неразличимы (DECISIONS 2026-10-30 14:24)
    it('vacation.cancelled при отмене и при отзыве без by', async () => {
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const a = await vacation('employee1');
      await cancel('employee1', a.id);
      const b = await vacation('employee2');
      await setDbClock(pool, DURING);
      await recall('hr', b.id, END);
      expect(publish.mock.calls).toEqual([
        [
          {
            type: 'vacation.cancelled',
            employeeId: ids.employee1,
            vacationId: a.id,
          },
        ],
        [
          {
            type: 'vacation.cancelled',
            employeeId: ids.employee2,
            vacationId: b.id,
          },
        ],
      ]);
    });

    // RULES §10-2: отказ ничего не публикует
    it('отказ - событий нет', async () => {
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const { id } = await vacation('employee1');
      await cancel('hr', id);
      await recall('hr', id, START);
      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('actions: подсказка кнопок по зрителю (architecture §7)', () => {
    const actionsOf = async (login: RulesOrgKey, id: number) =>
      (await get(login, `/vacations/${id}`)).body.actions;

    // RULES §5-1, §5-4, §5-5, §5-10, §7-2: перенос владельцу до начала - S6-b
    it('до начала: владельцу cancel и transfer, руководителю и HR ничего', async () => {
      const { id } = await vacation('employee1');
      expect(await actionsOf('employee1', id)).toEqual(['cancel', 'transfer']);
      expect(await actionsOf('manager1', id)).toEqual([]);
      expect(await actionsOf('hr', id)).toEqual([]);
    });

    // RULES §5-5, §5-7
    it('отпуск идёт: HR recall, владельцу и руководителю ничего', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, DURING);
      expect(await actionsOf('hr', id)).toEqual(['recall']);
      expect(await actionsOf('employee1', id)).toEqual([]);
      expect(await actionsOf('manager1', id)).toEqual([]);
    });

    // RULES §5-5 (DECISIONS 2026-10-28 15:41): после окончания отзыва нет
    it('отпуск закончился: ни у кого действий нет', async () => {
      const { id } = await vacation('employee1');
      await setDbClock(pool, '2026-11-14T03:00:00.000Z');
      expect(await actionsOf('hr', id)).toEqual([]);
      expect(await actionsOf('employee1', id)).toEqual([]);
    });

    // RULES §5-4, §5-5 (DECISIONS 2026-10-28 15:41): свой отпуск HR - cancel до начала, recall во время
    it('свой отпуск HR: cancel и transfer до начала, recall во время', async () => {
      const { id } = await vacation('hr');
      expect(await actionsOf('hr', id)).toEqual(['cancel', 'transfer']);
      await setDbClock(pool, DURING);
      expect(await actionsOf('hr', id)).toEqual(['recall']);
    });

    // RULES §5-10: «На согласовании» после начала - ни отмены, ни отзыва
    it('«На согласовании» после начала: у владельца и HR нет cancel и recall', async () => {
      const { id } = await vacation('employee1', { status: 'PENDING' });
      await setDbClock(pool, DURING);
      expect(await actionsOf('employee1', id)).toEqual([]);
      expect(await actionsOf('hr', id)).toEqual([]);
    });
  });
});
