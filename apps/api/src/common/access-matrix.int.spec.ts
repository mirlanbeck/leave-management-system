// Матрица доступа: маршрут x роль -> ожидаемый статус. Этапы S4-S8 дописывают сюда строки
// (RULES §7-2). Здесь строки S3.
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
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
}

const CLOCK_BODY = { date: '2026-10-02', time: '09:00' };

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
    await seedRulesOrg(pool, await passwordHash());
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
      const app = row.demo ? apps.on : apps.off;
      const token = tokens[actor];
      let req = request(app.getHttpServer())[row.method](row.path);
      if (token) req = req.set(bearer(token));
      const res = await (row.body ? req.send(row.body) : req);
      expect(res.status).toBe(row.expected[actor]);
    });
  });
});
