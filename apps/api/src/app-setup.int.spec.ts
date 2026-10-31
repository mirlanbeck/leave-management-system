import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createTestApp } from './testing/test-app';

// DECISIONS 2026-10-31 10:33; аудит 3, F-10: api не раскрывает Express заголовком X-Powered-By
// (пункта в RULES нет; метка по CLAUDE.md, правило 3, согласовано). main.ts проверяет e2e на порту 3000.
describe('X-Powered-By (integration, нужен Postgres: DATABASE_URL)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('нет на открытом маршруте /health', async () => {
    const res = await request(app.getHttpServer() as App).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('нет на ошибке: неизвестный маршрут без токена', async () => {
    const res = await request(app.getHttpServer() as App).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
