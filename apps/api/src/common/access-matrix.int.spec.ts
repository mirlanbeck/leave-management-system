// Матрица доступа: маршрут x роль -> ожидаемый статус. Этапы S4-S8 дописывают сюда строки
// (RULES §7-2). Здесь строки S3, S4, S5 (в том числе календарь S5-e), S6-a (отмена, отзыв) и S6-b (перенос).
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  PASSWORD,
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

type Actor =
  'director' | 'deputy' | 'hr' | 'manager1' | 'employee1' | 'preHire' | 'anon';
type Method = 'get' | 'post' | 'put';

const ACTORS: Actor[] = [
  'director',
  'deputy',
  'hr',
  'manager1',
  'employee1',
  'preHire',
  'anon',
];

/** Статус для всех вошедших и отдельно для анонима. */
const signedIn = (status: number, anon = 401): Record<Actor, number> => ({
  director: status,
  deputy: status,
  hr: status,
  manager1: status,
  employee1: status,
  preHire: status,
  anon,
});

interface Row {
  method: Method;
  path: string;
  body?: object;
  demo: boolean;
  expected: Record<Actor, number>;
  rules: string;
  /** Заявка employee1 в PENDING (id 1 после RESTART IDENTITY) до запроса. */
  pendingVacation?: boolean;
}

const CLOCK_BODY = { date: '2026-10-02', time: '09:00' };
// заменяющий - manager2 (id 5 после TRUNCATE ... RESTART IDENTITY, порядок seedRulesOrg), не актёр
const VACATION_BODY = {
  startDate: '2026-11-02',
  endDate: '2026-11-06',
  backstopperId: 5,
};

const ROWS: Row[] = [
  {
    method: 'get',
    path: '/me',
    demo: true,
    expected: signedIn(200),
    rules: '§7-2',
  },
  {
    method: 'get',
    path: '/clock',
    demo: true,
    expected: signedIn(200),
    rules: '§9-2',
  },
  {
    method: 'put',
    path: '/clock',
    body: CLOCK_BODY,
    demo: true,
    expected: signedIn(200),
    rules: '§9-3',
  },
  {
    method: 'get',
    path: '/clock',
    demo: false,
    expected: signedIn(404),
    rules: '§9-2',
  },
  {
    method: 'put',
    path: '/clock',
    body: CLOCK_BODY,
    demo: false,
    expected: signedIn(404),
    rules: '§9-2',
  },
  {
    method: 'get',
    path: '/employees',
    demo: true,
    expected: signedIn(200),
    rules: '§3-3',
  },
  {
    method: 'get',
    path: '/me/balance',
    demo: true,
    expected: signedIn(200),
    rules: '§3-10',
  },
  {
    method: 'get',
    path: '/vacations',
    demo: true,
    expected: signedIn(200),
    rules: '§7-2',
  },
  {
    // руководитель = есть прямые подчинённые (директор, заместитель, руководитель 1)
    method: 'get',
    path: '/vacations?scope=team',
    demo: true,
    expected: {
      director: 200,
      deputy: 200,
      hr: 403,
      manager1: 200,
      employee1: 403,
      preHire: 403,
      anon: 401,
    },
    rules: '§7-2',
  },
  {
    method: 'get',
    path: '/vacations?scope=all',
    demo: true,
    expected: {
      director: 403,
      deputy: 403,
      hr: 200,
      manager1: 403,
      employee1: 403,
      preHire: 403,
      anon: 401,
    },
    rules: '§7-2',
  },
  {
    // заявки нет ни у кого: невидимая и несуществующая отвечают одинаково
    method: 'get',
    path: '/vacations/1',
    demo: true,
    expected: signedIn(404),
    rules: '§7-2',
  },
  {
    // подать может любой вошедший с начислением; до первого начисления 422 NO_ACCRUAL_YET
    method: 'post',
    path: '/vacations',
    body: VACATION_BODY,
    demo: true,
    expected: { ...signedIn(201), preHire: 422 },
    rules: '§3-6, §10-1',
  },
  {
    // согласующий - руководитель или HR (RULES §4-7); HR видит здесь заявки директора
    method: 'get',
    path: '/approvals',
    demo: true,
    expected: {
      director: 200,
      deputy: 200,
      hr: 200,
      manager1: 200,
      employee1: 403,
      preHire: 403,
      anon: 401,
    },
    rules: '§4-7',
  },
  ...(['approve', 'reject'] as const).map((decision): Row => ({
    // решает только согласующий; автор - 403 APPROVE_OWN_REQUEST, HR - 403 NOT_APPROVER,
    // кому заявка не видна - 404 (RULES §4-1, §4-2, §7-2)
    method: 'post',
    path: `/vacations/1/${decision}`,
    demo: true,
    pendingVacation: true,
    expected: {
      director: 404,
      deputy: 404,
      hr: 403,
      manager1: 200,
      employee1: 403,
      preHire: 404,
      anon: 401,
    },
    rules: '§4-1, §4-2, §7-2',
  })),
  {
    // отменяет только владелец (заявка PENDING до начала); руководитель и HR видят, но 403;
    // кому заявка не видна - 404 (RULES §5-4, §5-10, §7-2)
    method: 'post',
    path: '/vacations/1/cancel',
    body: {},
    demo: true,
    pendingVacation: true,
    expected: {
      director: 404,
      deputy: 404,
      hr: 403,
      manager1: 403,
      employee1: 200,
      preHire: 404,
      anon: 401,
    },
    rules: '§5-4, §5-10, §7-2',
  },
  {
    // отзывает только HR: заявка PENDING до начала - 422 RECALL_NOT_APPROVED; руководитель и
    // владелец видят, но 403; кому не видна - 404 (RULES §5-5, §7-2)
    method: 'post',
    path: '/vacations/1/recall',
    body: { returnDate: '2026-11-02' },
    demo: true,
    pendingVacation: true,
    expected: {
      director: 404,
      deputy: 404,
      hr: 422,
      manager1: 403,
      employee1: 403,
      preHire: 404,
      anon: 401,
    },
    rules: '§5-5, §7-2',
  },
  {
    // переносит только владелец: его заявка PENDING - 422 TRANSFER_SOURCE_NOT_APPROVED;
    // руководитель и HR видят, но 403; кому не видна - 404 (RULES §5-2, §7-2)
    method: 'post',
    path: '/vacations/1/transfer',
    body: { startDate: '2026-11-16', endDate: '2026-11-20', backstopperId: 5 },
    demo: true,
    pendingVacation: true,
    expected: {
      director: 404,
      deputy: 404,
      hr: 403,
      manager1: 403,
      employee1: 422,
      preHire: 404,
      anon: 401,
    },
    rules: '§5-2, §7-2',
  },
  {
    // календарь видит любой вошедший; кого он показывает, решает scope (RULES §7-2)
    method: 'get',
    path: '/calendar?from=2026-11-01&to=2026-11-30',
    demo: true,
    expected: signedIn(200),
    rules: '§7-2',
  },
  {
    method: 'get',
    path: '/config',
    demo: true,
    expected: signedIn(200, 200),
    rules: '§9-2',
  },
  {
    method: 'get',
    path: '/health',
    demo: true,
    expected: signedIn(200, 200),
    rules: '§8-1',
  },
  {
    method: 'post',
    path: '/auth/login',
    body: { login: 'employee2', password: PASSWORD },
    demo: true,
    expected: signedIn(200, 200),
    rules: '§7-1',
  },
];

describe('матрица доступа (integration, нужен Postgres)', () => {
  let pool: Pool;
  let apps: { on: INestApplication; off: INestApplication };
  let tokens: Partial<Record<Actor, string>>;
  let ids: Record<RulesOrgKey, number>;

  beforeAll(async () => {
    pool = createPool();
    apps = {
      on: await createTestApp({ DEMO_MODE: 'true' }),
      off: await createTestApp({}),
    };
  });

  beforeEach(async () => {
    await truncateAll(pool);
    // 2026-10-01: сотрудник 3 (дата выхода 2026-10-12) ещё не вышел, но признак доступа у него есть
    await setDbClock(pool, '2026-10-01T03:00:00Z');
    ids = await seedRulesOrg(pool, await passwordHash());
    const key: Record<Exclude<Actor, 'anon'>, RulesOrgKey> = {
      director: 'director',
      deputy: 'deputy',
      hr: 'hr',
      manager1: 'manager1',
      employee1: 'employee1',
      preHire: 'employee3',
    };
    tokens = {};
    for (const actor of ACTORS) {
      if (actor !== 'anon') tokens[actor] = await loginAs(apps.on, key[actor]);
    }
  });

  afterAll(async () => {
    await apps.on.close();
    await apps.off.close();
    await pool.end();
  });

  describe.each(ROWS)('$method $path (demo: $demo)', (row) => {
    // RULES §7-2, §6-5
    it.each(ACTORS)('%s', async (actor) => {
      await setDbClock(pool, '2026-10-01T03:00:00Z');
      if (row.pendingVacation) {
        await insertVacation(pool, {
          employeeId: ids.employee1,
          backstopperId: ids.manager2,
          start: '2026-11-02',
          end: '2026-11-06',
        });
      }
      const app = row.demo ? apps.on : apps.off;
      const token = tokens[actor];
      let req = request(app.getHttpServer() as App)[row.method](row.path);
      if (token) req = req.set(bearer(token));
      const res = await (row.body ? req.send(row.body) : req);
      expect(res.status).toBe(row.expected[actor]);
    });
  });
});
