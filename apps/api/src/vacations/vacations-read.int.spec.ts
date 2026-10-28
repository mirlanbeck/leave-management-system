/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
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
  insertVacation,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';

describe('чтение заявок: GET /vacations, GET /vacations/{id} (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;

  const get = async (login: RulesOrgKey, path: string) => {
    const token = await loginAs(app, login);
    return request(app.getHttpServer()).get(path).set(bearer(token));
  };
  const idsOf = (res: request.Response): number[] =>
    (res.body as { id: number }[]).map((v) => v.id);

  /** Заявка сотрудника `who` с заменяющим `by`; даты не важны для чтения. */
  const vac = (
    who: RulesOrgKey,
    by: RulesOrgKey,
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REPLACED',
    extra: { start?: string; end?: string; replacesId?: number } = {},
  ) =>
    insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: ids[by],
      start: extra.start ?? '2026-11-02',
      end: extra.end ?? '2026-11-06',
      status,
      replacesId: extra.replacesId,
    });

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, '2026-10-21T03:00:00Z');
    ids = await seedRulesOrg(pool, await passwordHash());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §7-1
  it.each(['/vacations', '/vacations/1'])(
    '%s без токена -> 401',
    async (path) => {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_REQUIRED');
    },
  );

  describe('список: scope=mine (по умолчанию)', () => {
    // RULES §7-2: сотрудник видит только свои заявки
    it('только свои, новые первыми; чужие и где он backstopper не видны', async () => {
      const first = await vac('employee1', 'employee2', 'APPROVED');
      const second = await vac('employee1', 'manager1', 'PENDING');
      await vac('employee2', 'employee1', 'PENDING'); // employee1 здесь backstopper
      await vac('employee4', 'employee5', 'PENDING');
      const res = await get('employee1', '/vacations');
      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([second, first]);
    });

    // RULES §7-2: руководитель и HR в режиме mine тоже только свои
    it.each(['manager1', 'hr', 'director'] as const)(
      '%s в mine видит только свои',
      async (login) => {
        const own = await vac(login, 'employee1', 'PENDING');
        await vac('employee1', login, 'PENDING');
        await vac('employee4', login, 'PENDING');
        const res = await get(login, '/vacations?scope=mine');
        expect(idsOf(res)).toEqual([own]);
      },
    );

    // RULES §3-11: фильтр по статусам, один и несколько
    it('фильтр status: один и несколько значений', async () => {
      const pending = await vac('employee1', 'employee2', 'PENDING');
      const approved = await vac('employee1', 'employee2', 'APPROVED');
      const rejected = await vac('employee1', 'employee2', 'REJECTED');
      expect(
        idsOf(await get('employee1', '/vacations?status=PENDING')),
      ).toEqual([pending]);
      expect(
        idsOf(
          await get('employee1', '/vacations?status=PENDING&status=REJECTED'),
        ),
      ).toEqual([rejected, pending]);
      expect(idsOf(await get('employee1', '/vacations'))).toEqual([
        rejected,
        approved,
        pending,
      ]);
    });
  });

  describe('список: scope=team', () => {
    // RULES §7-2, §7-3: руководитель видит заявки прямых подчинённых, не свои и не чужой команды
    it('руководитель: заявки прямых подчинённых', async () => {
      const a = await vac('employee1', 'employee2', 'PENDING');
      const b = await vac('employee3', 'employee2', 'APPROVED');
      await vac('manager1', 'employee1', 'PENDING');
      await vac('employee4', 'employee1', 'PENDING');
      await vac('deputy', 'employee1', 'PENDING');
      const res = await get('manager1', '/vacations?scope=team');
      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([b, a]);
    });

    // RULES §7-3: вложенные подчинённые в команду не входят
    it('заместитель видит заявки руководителей, но не их подчинённых', async () => {
      const m1 = await vac('manager1', 'employee1', 'PENDING');
      await vac('employee1', 'employee2', 'PENDING');
      const res = await get('deputy', '/vacations?scope=team');
      expect(idsOf(res)).toEqual([m1]);
    });

    // RULES §7-2: без подчинённых режим team недоступен (в том числе HR)
    it.each(['employee1', 'hr'] as const)(
      '%s -> 403 FORBIDDEN',
      async (login) => {
        const res = await get(login, '/vacations?scope=team');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      },
    );
  });

  describe('список: scope=all', () => {
    // RULES §7-2: HR видит все заявки компании, все статусы, на чтение
    it('HR: все заявки всех статусов', async () => {
      const created: number[] = [];
      for (const status of [
        'PENDING',
        'APPROVED',
        'REJECTED',
        'CANCELLED',
        'REPLACED',
      ] as const) {
        created.push(await vac('employee4', 'employee5', status));
      }
      created.push(await vac('director', 'hr', 'PENDING'));
      const res = await get('hr', '/vacations?scope=all');
      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([...created].sort((a, b) => b - a));
    });

    // RULES §7-2: не HR режим all не получает
    it.each(['employee1', 'manager1', 'director', 'deputy'] as const)(
      '%s -> 403 FORBIDDEN',
      async (login) => {
        const res = await get(login, '/vacations?scope=all');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      },
    );
  });

  // RULES §3-2: лишнее и неизвестное во входе отклоняется
  it.each(['?scope=everyone', '?status=DELETED', '?status=', '?foo=1'])(
    'запрос %s -> 400 VALIDATION_FAILED',
    async (query) => {
      const res = await get('employee1', `/vacations${query}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    },
  );

  describe('карточка', () => {
    // RULES §7-2: свою заявку видит владелец
    it('владелец: 200 и форма ответа из architecture §7', async () => {
      const id = await vac('employee1', 'employee2', 'PENDING', {
        start: '2026-11-02',
        end: '2026-11-06',
      });
      await pool.query(
        `UPDATE "Vacation" SET comment = 'семья' WHERE id = $1`,
        [id],
      );
      const res = await get('employee1', `/vacations/${id}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id,
        employee: { id: ids.employee1, fullName: 'Сотрудник employee1' },
        backstopper: { id: ids.employee2, fullName: 'Сотрудник employee2' },
        startDate: '2026-11-02',
        endDate: '2026-11-06',
        workDays: 5,
        status: 'PENDING',
        comment: 'семья',
        replacesId: null,
        createdAt: '2026-10-01T03:00:00.000Z',
        decidedBy: null,
        decidedAt: null,
        decisionComment: null,
        cancelledAt: null,
        returnDate: null,
        transferPending: false,
        oldVacationKept: false,
        actions: ['cancel'], // владелец до начала (RULES §5-4)
      });
    });

    // RULES §1-2: календарные даты без сдвига часового пояса
    it('даты без времени и без сдвига пояса', async () => {
      const id = await vac('employee1', 'employee2', 'PENDING', {
        start: '2026-12-28',
        end: '2026-12-31',
      });
      const res = await get('employee1', `/vacations/${id}`);
      expect(res.body.startDate).toBe('2026-12-28');
      expect(res.body.endDate).toBe('2026-12-31');
    });

    // RULES §4: решение отображается (кто и когда решил)
    it('решение: decidedBy, decidedAt, decisionComment', async () => {
      const id = await vac('employee1', 'employee2', 'REJECTED');
      await pool.query(
        `UPDATE "Vacation" SET "decidedById" = $2, "decidedAt" = '2026-10-02T04:00:00Z',
                "decisionComment" = 'нет' WHERE id = $1`,
        [id, ids.manager1],
      );
      const res = await get('employee1', `/vacations/${id}`);
      expect(res.body.decidedBy).toEqual({
        id: ids.manager1,
        fullName: 'Сотрудник manager1',
      });
      expect(res.body.decidedAt).toBe('2026-10-02T04:00:00.000Z');
      expect(res.body.decisionComment).toBe('нет');
    });

    // RULES §7-2: руководитель видит заявку подчинённого, HR любую
    it('руководитель: подчинённый -> 200; HR: любая -> 200', async () => {
      const id = await vac('employee1', 'employee2', 'APPROVED');
      expect((await get('manager1', `/vacations/${id}`)).status).toBe(200);
      expect((await get('hr', `/vacations/${id}`)).status).toBe(200);
    });

    // RULES §7-2: невидимая заявка -> 404, как и несуществующая
    it.each([
      { login: 'employee2', who: 'коллега по команде' },
      { login: 'manager2', who: 'руководитель чужой команды' },
      { login: 'deputy', who: 'вышестоящий, но не непосредственный' },
      { login: 'director', who: 'директор' },
    ] as const)('$login ($who) -> 404 NOT_FOUND', async ({ login }) => {
      const id = await vac('employee1', 'employee5', 'PENDING');
      const res = await get(login, `/vacations/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    // RULES §3-3, §7-2: backstopper заявку не видит
    it('backstopper: заявка, где он заменяющий, -> 404', async () => {
      const id = await vac('employee1', 'employee2', 'APPROVED');
      const res = await get('employee2', `/vacations/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    // RULES §7-2: несуществующий и некорректный id -> 404, а не 500
    it.each(['999999', 'abc', '0', '-1', '1.5', '99999999999999999999'])(
      'id "%s" -> 404',
      async (id) => {
        const res = await get('hr', `/vacations/${id}`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      },
    );
  });

  describe('пометки переноса (производные)', () => {
    // RULES §3-11: пока перенос ждёт решения, исходная «Одобрена» с пометкой «перенос на рассмотрении»
    it('исходная APPROVED с преемником PENDING: transferPending', async () => {
      const a = await vac('employee1', 'employee2', 'APPROVED');
      await vac('employee1', 'employee2', 'PENDING', {
        start: '2026-11-09',
        end: '2026-11-13',
        replacesId: a,
      });
      const res = await get('employee1', `/vacations/${a}`);
      expect(res.body.status).toBe('APPROVED');
      expect(res.body.transferPending).toBe(true);
    });

    // RULES §3-11: перенос отклонён или отменён -> «Старый отпуск остаётся», у исходной пометка снимается
    it.each(['REJECTED', 'CANCELLED'] as const)(
      'перенос %s: у переноса oldVacationKept, у исходной transferPending снят',
      async (status) => {
        const a = await vac('employee1', 'employee2', 'APPROVED');
        const b = await vac('employee1', 'employee2', status, {
          start: '2026-11-09',
          end: '2026-11-13',
          replacesId: a,
        });
        const old = await get('employee1', `/vacations/${a}`);
        const transfer = await get('employee1', `/vacations/${b}`);
        expect(old.body.transferPending).toBe(false);
        expect(transfer.body.oldVacationKept).toBe(true);
        expect(transfer.body.replacesId).toBe(a);
      },
    );

    // RULES §3-11: утверждённый перенос и обычные заявки пометок не имеют
    it('утверждённый перенос: пометок нет', async () => {
      const a = await vac('employee1', 'employee2', 'REPLACED');
      const b = await vac('employee1', 'employee2', 'APPROVED', {
        start: '2026-11-09',
        end: '2026-11-13',
        replacesId: a,
      });
      const res = await get('employee1', `/vacations/${b}`);
      expect(res.body.transferPending).toBe(false);
      expect(res.body.oldVacationKept).toBe(false);
    });
  });
});
