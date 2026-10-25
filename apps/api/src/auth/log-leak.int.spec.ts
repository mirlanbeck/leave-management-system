/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import {
  PASSWORD,
  bearer,
  passwordHash,
  setDbClock,
} from '../testing/int-helpers';
import { createTestApp } from '../testing/test-app';
import { createPool, seedRulesOrg, truncateAll } from '../testing/test-db';

/** Всё, что приложение и Nest пишут в stdout/stderr за время вызова. */
async function captureOutput(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = grab;
  process.stderr.write = grab;
  try {
    await run();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return chunks.join('');
}

describe('токен и пароль не попадают в логи (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, '2026-10-24T03:00:00Z');
    await seedRulesOrg(pool, await passwordHash());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §7-1
  it('успешный вход и запросы с токеном', async () => {
    let token = '';
    const logs = await captureOutput(async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ login: 'employee1', password: PASSWORD });
      token = (res.body as { accessToken: string }).accessToken;
      await request(app.getHttpServer()).get('/me').set(bearer(token));
    });
    expect(token).not.toBe('');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(PASSWORD);
  });

  // RULES §7-1
  it('неверный пароль (401)', async () => {
    const logs = await captureOutput(async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ login: 'employee1', password: 'секретный-неверный' });
    });
    expect(logs).not.toContain('секретный-неверный');
  });

  // RULES §7-1
  it('внутренняя ошибка (500)', async () => {
    const dead = await createTestApp({}, (b) =>
      b
        .overrideProvider(PrismaService)
        .useValue(new PrismaService('postgresql://x:x@127.0.0.1:1/x')),
    );
    try {
      let status = 0;
      const logs = await captureOutput(async () => {
        const res = await request(dead.getHttpServer())
          .post('/auth/login')
          .send({ login: 'employee1', password: 'hunter2-пароль' });
        status = res.status;
      });
      expect(status).toBe(500);
      expect(logs).not.toContain('hunter2-пароль');
    } finally {
      await dead.close();
    }
  });

  // RULES §7-1: токен только из заголовка
  it('токен в URL (?access_token=) игнорируется', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login: 'employee1', password: PASSWORD });
    const token = (login.body as { accessToken: string }).accessToken;
    const res = await request(app.getHttpServer()).get(
      `/me?access_token=${token}&token=${token}`,
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });
});
