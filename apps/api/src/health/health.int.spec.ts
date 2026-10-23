import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { HealthModule } from './health.module';
import { PrismaModule } from '../prisma/prisma.module';

// RULES §8-1: сервис поднимается вместе с Postgres; /health проверяет БД (SELECT 1)
describe('GET /health (integration, нужен Postgres: DATABASE_URL)', () => {
  async function createApp(prisma?: PrismaService): Promise<INestApplication> {
    let builder = Test.createTestingModule({
      imports: [PrismaModule, HealthModule],
    });
    if (prisma) {
      builder = builder.overrideProvider(PrismaService).useValue(prisma);
    }
    const app = (await builder.compile()).createNestApplication();
    await app.init();
    return app;
  }

  it('200, когда БД доступна', async () => {
    const app = await createApp();
    try {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('503, когда БД недоступна', async () => {
    const dead = new PrismaService('postgresql://x:x@127.0.0.1:1/x');
    const app = await createApp(dead);
    try {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(503);
    } finally {
      await app.close();
    }
  });
});
