import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { APP_ENV } from './app-config';
import { AppConfigModule } from './config.module';

describe('GET /config', () => {
  async function createApp(env: NodeJS.ProcessEnv): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule],
    })
      .overrideProvider(APP_ENV)
      .useValue(env)
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  // RULES §9-2
  it('публичный: без токена отдаёт признак демо-режима и пояс компании', async () => {
    const app = await createApp({ DEMO_MODE: 'true', COMPANY_TZ: 'UTC' });
    try {
      const res = await request(app.getHttpServer()).get('/config');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ demoMode: true, companyTz: 'UTC' });
    } finally {
      await app.close();
    }
  });

  // RULES §9-2
  it('без флага demoMode = false, пояс по умолчанию Asia/Bishkek', async () => {
    const app = await createApp({ DEMO_MODE: 'True' });
    try {
      const res = await request(app.getHttpServer()).get('/config');
      expect(res.body).toEqual({ demoMode: false, companyTz: 'Asia/Bishkek' });
    } finally {
      await app.close();
    }
  });
});
