/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- тела ответов supertest и строки pg имеют тип any */
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

// Среда 2026-10-21, 09:17 по Бишкеку. Баланс employee1 (выход 2022-03-15) сегодня 37,5.
// Старый отпуск A: пн 2026-11-09 – пт 2026-11-13, одобрен (списание 5 дней), остаток 32,5.
// Перенос B: пн 2026-11-16 – пт 2026-11-20.
const NOW = '2026-10-21T03:17:42.123Z';
// Понедельник 2026-11-09, 09:00 по Бишкеку: старый отпуск A начался
const A_STARTED = '2026-11-09T03:00:00.000Z';
const START = '2026-11-09';
const END = '2026-11-13';
const NEW_START = '2026-11-16';
const NEW_END = '2026-11-20';

type Body = Record<string, unknown>;

describe('согласование переноса (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;
  let tokens: Partial<Record<RulesOrgKey, string>>;

  const token = async (login: RulesOrgKey) =>
    (tokens[login] ??= await loginAs(app, login));
  // токен берётся до создания запроса: вход закрывает временный сервер supertest
  const post = async (login: RulesOrgKey, path: string, body: Body = {}) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer()).post(path).set(auth).send(body);
  };
  const get = async (login: RulesOrgKey, path: string) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer()).get(path).set(auth);
  };
  const backstopperOf = (who: RulesOrgKey) =>
    who === 'employee2' ? ids.employee1 : ids.employee2;
  const approve = (login: RulesOrgKey, id: number) =>
    post(login, `/vacations/${id}/approve`);
  const reject = (login: RulesOrgKey, id: number) =>
    post(login, `/vacations/${id}/reject`);
  const cancel = (login: RulesOrgKey, id: number) =>
    post(login, `/vacations/${id}/cancel`);
  const transfer = async (
    who: RulesOrgKey,
    id: number,
    startDate = NEW_START,
    endDate = NEW_END,
  ) => {
    const res = await post(who, `/vacations/${id}/transfer`, {
      startDate,
      endDate,
      backstopperId: backstopperOf(who),
    });
    expect(res.status).toBe(201);
    return res.body.id as number;
  };
  const balance = async (login: RulesOrgKey) =>
    (await get(login, '/me/balance')).body.balance;

  /** Одобренный отпуск со списанием всех дней, как после согласования. */
  const approved = async (
    who: RulesOrgKey,
    start = START,
    end = END,
    workDays = 5,
  ) => {
    const id = await insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: backstopperOf(who),
      start,
      end,
      workDays,
      status: 'APPROVED',
    });
    const debitId = await insertLedger(pool, {
      kind: 'DEBIT',
      vacationId: id,
      halfDays: workDays * 2,
    });
    return { id, debitId };
  };
  /** Старый отпуск A и перенос B «На согласовании». */
  const pendingTransfer = async (who: RulesOrgKey = 'employee1') => {
    const a = await approved(who);
    return { a: a.id, debitA: a.debitId, b: await transfer(who, a.id) };
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
  const decisions = async () =>
    (
      await pool.query(
        `SELECT "vacationId", "recipientId", subject FROM "OutboxMessage"
         WHERE type = 'DECISION' ORDER BY id`,
      )
    ).rows;

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

  describe('утверждение', () => {
    // RULES §3-11, §5-2, §6-6: старый «Заменена переносом», новый «Одобрена», журнал не меняется
    it('старый REPLACED, перенос APPROVED, списание остаётся за старым, баланс тот же', async () => {
      const { a, b } = await pendingTransfer();
      const res = await approve('manager1', b);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: b,
        status: 'APPROVED',
        replacesId: a,
        decidedBy: { id: ids.manager1 },
        decidedAt: NOW,
      });
      expect(await statusOf(a)).toBe('REPLACED');
      expect(await ledger()).toEqual([
        { kind: 'DEBIT', vacationId: a, refundOfId: null, halfDays: 10 },
      ]);
      expect(await balance('employee1')).toBe(32.5);
      const old = await get('employee1', `/vacations/${a}`);
      expect(old.body).toMatchObject({
        status: 'REPLACED',
        transferPending: false,
        actions: [],
      });
    });

    // RULES §8-2, §8-3 «Письма при переносе»: одно письмо о решении, о старом отпуске писем нет
    it('одно письмо DECISION сотруднику по переносу, по старому отпуску писем нет', async () => {
      const { b } = await pendingTransfer();
      await approve('manager1', b);
      expect(await decisions()).toEqual([
        {
          vacationId: b,
          recipientId: ids.employee1,
          subject: `Заявка на отпуск одобрена: ${NEW_START}–${NEW_END}`,
        },
      ]);
    });

    // RULES §10-2: перенос утверждён - событие transfer-approved, не approved
    it('событие vacation.transfer-approved с id старого отпуска', async () => {
      const { a, b } = await pendingTransfer();
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      await approve('manager1', b);
      expect(publish.mock.calls).toEqual([
        [
          {
            type: 'vacation.transfer-approved',
            employeeId: ids.employee1,
            vacationId: b,
            replacedId: a,
          },
        ],
      ]);
    });

    // RULES §4-2, §8-2: перенос директора решает HR, письмо о решении директору
    it('перенос директора: решает HR («допуск HR»), письмо директору', async () => {
      const { a, b } = await pendingTransfer('director');
      expect((await approve('hr', b)).status).toBe(200);
      expect(await statusOf(a)).toBe('REPLACED');
      expect(await decisions()).toEqual([
        {
          vacationId: b,
          recipientId: ids.director,
          subject: `Допуск HR: заявка на отпуск одобрена, ${NEW_START}–${NEW_END}`,
        },
      ]);
    });

    // RULES §4-1, §8-6: перенос HR решает заместитель, письмо о решении получает HR
    it('перенос HR: решает заместитель директора, письмо HR', async () => {
      const { b } = await pendingTransfer('hr');
      expect((await approve('deputy', b)).status).toBe(200);
      expect((await decisions())[0].recipientId).toBe(ids.hr);
    });

    // RULES §4-1, §4-2: решает только согласующий, автор - никогда
    it('не согласующий - 403 NOT_APPROVER, автор - 403 APPROVE_OWN_REQUEST', async () => {
      const { b } = await pendingTransfer();
      expect((await approve('hr', b)).body.code).toBe('NOT_APPROVER');
      expect((await approve('employee1', b)).body.code).toBe(
        'APPROVE_OWN_REQUEST',
      );
    });

    // RULES §10-1: повторное решение - «уже обработана»
    it('повторное утверждение - 409 ALREADY_PROCESSED, писем и списаний не прибавилось', async () => {
      const { b } = await pendingTransfer();
      await approve('manager1', b);
      const again = await approve('manager1', b);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_PROCESSED');
      expect(await decisions()).toHaveLength(1);
      expect(await ledger()).toHaveLength(1);
    });
  });

  describe('утверждение после начала старого отпуска', () => {
    // RULES §5-2 «Перенос нельзя утвердить, если старый отпуск уже начался»
    it('422 TRANSFER_APPROVE_AFTER_START, ничего не меняется; отклонить можно', async () => {
      const { a, b } = await pendingTransfer();
      await setDbClock(pool, A_STARTED);
      const res = await approve('manager1', b);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: 'TRANSFER_APPROVE_AFTER_START',
        message: 'Старый отпуск уже начался: перенос можно только отклонить',
      });
      expect(await statusOf(a)).toBe('APPROVED');
      expect(await statusOf(b)).toBe('PENDING');
      expect(await decisions()).toEqual([]);

      expect((await reject('manager1', b)).status).toBe(200);
      expect(await statusOf(a)).toBe('APPROVED');
    });

    // RULES §4-5, §5-2: важен старт старого отпуска, а не переноса
    it('перенос на более ранние даты: начался перенос, но не старый - утверждается', async () => {
      const a = await approved('employee1', '2026-12-07', '2026-12-11');
      const b = await transfer('employee1', a.id, '2026-11-02', '2026-11-06');
      await setDbClock(pool, '2026-11-04T03:00:00.000Z');
      expect((await approve('manager1', b)).status).toBe(200);
      expect(await statusOf(a.id)).toBe('REPLACED');
    });
  });

  describe('экран «Заявки на согласование»', () => {
    type Item = Body & {
      vacation: { id: number };
      overlaps: { vacationId: number }[];
    };
    const itemOf = async (login: RulesOrgKey, id: number) =>
      ((await get(login, '/approvals')).body as Item[]).find(
        (i) => i.vacation.id === id,
      );

    // RULES §4-7, §5-2: остаток для переноса не проверяется и не показывается
    it('перенос: availableOnStart null, утвердить можно', async () => {
      const { b } = await pendingTransfer();
      expect(await itemOf('manager1', b)).toMatchObject({
        availableOnStart: null,
        canApprove: true,
        blockReason: null,
      });
    });

    // RULES §5-2: после начала старого - причина блокировки
    it('старый начался: canApprove false, причина TRANSFER_APPROVE_AFTER_START', async () => {
      const { b } = await pendingTransfer();
      await setDbClock(pool, A_STARTED);
      expect(await itemOf('manager1', b)).toMatchObject({
        canApprove: false,
        blockReason: {
          statusCode: 422,
          code: 'TRANSFER_APPROVE_AFTER_START',
          message: 'Старый отпуск уже начался: перенос можно только отклонить',
        },
      });
    });

    // RULES §4-6; architecture, разделы 5 и 13 (п. 9): переносимый отпуск в пересечениях не участвует
    it('пересечения: старый отпуск сотрудника не показан, отпуск коллеги показан', async () => {
      const { a, b } = await pendingTransfer();
      const colleague = await approved(
        'employee2',
        '2026-11-18',
        '2026-11-19',
        2,
      );
      // перенос, пересекающийся и со старым отпуском
      await cancel('employee1', b);
      const overlapping = await transfer(
        'employee1',
        a,
        '2026-11-12',
        '2026-11-18',
      );
      const item = await itemOf('manager1', overlapping);
      expect(item?.overlaps.map((o) => o.vacationId)).toEqual([colleague.id]);
    });
  });

  describe('отклонение и отмена переноса', () => {
    // RULES §3-11, §8-2: «Отклонена» с «Старый отпуск остаётся», письмо о решении
    it('отклонение: перенос REJECTED с пометкой, старый APPROVED без пометки, письмо, событий нет', async () => {
      const { a, b } = await pendingTransfer();
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      const res = await reject('manager1', b);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        oldVacationKept: true,
      });
      expect((await get('employee1', `/vacations/${a}`)).body).toMatchObject({
        status: 'APPROVED',
        transferPending: false,
      });
      expect(await decisions()).toEqual([
        {
          vacationId: b,
          recipientId: ids.employee1,
          subject: `Заявка на отпуск отклонена: ${NEW_START}–${NEW_END}`,
        },
      ]);
      expect(publish).not.toHaveBeenCalled();
      expect(await balance('employee1')).toBe(32.5);
    });

    // RULES §5-2, §5-3: после отклонения старый можно перенести снова
    it('после отклонения старый отпуск можно перенести снова', async () => {
      const { a, b } = await pendingTransfer();
      await reject('manager1', b);
      await transfer('employee1', a, '2026-11-23', '2026-11-27');
    });
  });

  describe('конкурентность (RULES §10-1)', () => {
    // Порядок решает блокировка User: отмена первой - утверждение «уже обработана», старый
    // остаётся; утверждение первым - перенос одобрен до начала, и владелец законно отменяет его
    // с возвратом к списанию старого (RULES §5-4, §5-12, §6-8). Перенос отменён в обоих случаях.
    it('утверждение и отмена переноса одновременно: результат одного из последовательных порядков', async () => {
      const { a, debitA, b } = await pendingTransfer();
      await token('manager1');
      await token('employee1');
      const [approvedRes, cancelledRes] = await Promise.all([
        approve('manager1', b),
        cancel('employee1', b),
      ]);
      expect(cancelledRes.status).toBe(200);
      expect(await statusOf(b)).toBe('CANCELLED');
      if (approvedRes.status === 200) {
        expect(await statusOf(a)).toBe('REPLACED');
        expect(await ledger()).toEqual([
          { kind: 'DEBIT', vacationId: a, refundOfId: null, halfDays: 10 },
          { kind: 'REFUND', vacationId: b, refundOfId: debitA, halfDays: 10 },
        ]);
      } else {
        expect(approvedRes.body.code).toBe('ALREADY_PROCESSED');
        expect(await statusOf(a)).toBe('APPROVED');
        expect(await ledger()).toHaveLength(1);
      }
    });

    // RULES §5-3: старый отпуск не отменяется ни до, ни после утверждения переноса
    it('утверждение переноса и отмена старого одновременно: отмена отклонена, возврата нет', async () => {
      const { a, b } = await pendingTransfer();
      await token('manager1');
      await token('employee1');
      const [approvedRes, cancelledRes] = await Promise.all([
        approve('manager1', b),
        cancel('employee1', a),
      ]);
      expect(approvedRes.status).toBe(200);
      expect(cancelledRes.status).toBe(409);
      expect(['PENDING_TRANSFER_BLOCKS', 'ALREADY_PROCESSED']).toContain(
        cancelledRes.body.code,
      );
      expect(await statusOf(a)).toBe('REPLACED');
      expect(await ledger()).toHaveLength(1);
    });
  });

  describe('цепочка A→B→C через API', () => {
    // RULES §5-12, §6-8: прежние звенья не оживают, возврат к списанию корня
    it('A→B, B→C утверждены; отмена C возвращает дни по списанию A, A и B остаются REPLACED', async () => {
      const { a, debitA, b } = await pendingTransfer();
      await approve('manager1', b);
      const c = await transfer('employee1', b, '2026-11-23', '2026-11-27');
      expect((await approve('manager1', c)).status).toBe(200);
      expect(await statusOf(a)).toBe('REPLACED');
      expect(await statusOf(b)).toBe('REPLACED');
      expect(await balance('employee1')).toBe(32.5);

      expect((await cancel('employee1', c)).status).toBe(200);
      expect(await ledger()).toEqual([
        { kind: 'DEBIT', vacationId: a, refundOfId: null, halfDays: 10 },
        { kind: 'REFUND', vacationId: c, refundOfId: debitA, halfDays: 10 },
      ]);
      expect(await statusOf(a)).toBe('REPLACED');
      expect(await statusOf(b)).toBe('REPLACED');
      expect(await balance('employee1')).toBe(37.5);

      // RULES §10-1: повторная отмена второго возврата не создаёт
      expect((await cancel('employee1', c)).body.code).toBe(
        'ALREADY_PROCESSED',
      );
      expect(await ledger()).toHaveLength(2);
    });
  });
});
