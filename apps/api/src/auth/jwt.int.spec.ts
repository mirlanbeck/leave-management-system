/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import request from 'supertest';
import {
  PASSWORD,
  bearer,
  passwordHash,
  setDbClock,
} from '../testing/int-helpers';
import { TEST_JWT_SECRET, createTestApp } from '../testing/test-app';
import { createPool, seedRulesOrg, truncateAll } from '../testing/test-db';

describe('JWT (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let employee1: number;
  const signer = new JwtService({ secret: TEST_JWT_SECRET });

  const login = async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ login: 'employee1', password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body as { accessToken: string; expiresAt: string };
  };
  const me = (token: string) =>
    request(app.getHttpServer()).get('/me').set(bearer(token));
  const decode = (token: string) => ({
    header: JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString(),
    ) as Record<string, unknown>,
    payload: JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString(),
    ) as Record<string, number | string>,
  });

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, '2026-10-24T03:00:00Z');
    employee1 = (await seedRulesOrg(pool, await passwordHash())).employee1;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §7-1
  it('HS256, в payload только sub, iat, exp', async () => {
    const { accessToken } = await login();
    const { header, payload } = decode(accessToken);
    expect(header.alg).toBe('HS256');
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(payload.sub).toBe(String(employee1));
  });

  // RULES §9-1
  it('срок 8 часов, expiresAt равен exp', async () => {
    const { accessToken, expiresAt } = await login();
    const { payload } = decode(accessToken);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(28800);
    expect(expiresAt).toBe(new Date(Number(payload.exp) * 1000).toISOString());
  });

  // RULES §7-1
  it('действительный токен открывает /me', async () => {
    const { accessToken } = await login();
    expect((await me(accessToken)).status).toBe(200);
  });

  // RULES §7-1
  it('HS384 -> 401 AUTH_REQUIRED', async () => {
    const token = signer.sign(
      {},
      { subject: String(employee1), algorithm: 'HS384', expiresIn: 60 },
    );
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('alg:none -> 401 AUTH_REQUIRED', async () => {
    const enc = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: String(employee1) })}.`;
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('чужой секрет -> 401 AUTH_REQUIRED', async () => {
    const token = new JwtService({ secret: 'чужой секрет' }).sign(
      {},
      { subject: String(employee1), expiresIn: 60 },
    );
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('просроченный -> 401 AUTH_TOKEN_EXPIRED', async () => {
    const token = signer.sign(
      {},
      { subject: String(employee1), expiresIn: -10 },
    );
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  // RULES §7-1, §9-1: токен без срока не принимается
  it('верная подпись без exp -> 401 AUTH_REQUIRED', async () => {
    const token = signer.sign({}, { subject: String(employee1) });
    expect(decode(token).payload.exp).toBeUndefined();
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('sub несуществующего пользователя -> 401 AUTH_REQUIRED', async () => {
    const token = signer.sign({}, { subject: '99999', expiresIn: 60 });
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  // RULES §9-1: срок токена по системным часам, не по демо-часам
  it('демо-часы вперёд не истекают токен, назад не продлевают', async () => {
    const { accessToken } = await login();
    await setDbClock(pool, '2030-01-01T03:00:00Z');
    expect((await me(accessToken)).status).toBe(200);

    const expired = signer.sign(
      {},
      { subject: String(employee1), expiresIn: -10 },
    );
    await setDbClock(pool, '2000-01-01T03:00:00Z');
    const res = await me(expired);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_TOKEN_EXPIRED');
  });
});
