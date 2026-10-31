// Фабрика тестового приложения: тот же AppModule, что и в проде (guard, фильтр и пайп приходят
// из модулей), подменяется только окружение. Не попадает в сборку (tsconfig.build.json).
import { INestApplication } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from '../app-setup';
import { AppModule } from '../app.module';
import { APP_ENV } from '../config/app-config';
import { OutboxWorker } from '../mail/outbox-worker';
import { ReminderWorker } from '../scheduler/reminder-worker';
import { DATABASE_URL } from './test-db';

export const TEST_JWT_SECRET = 'test-secret-not-for-production';

export type TestEnv = Record<string, string | undefined>;

export function testEnv(extra: TestEnv = {}): NodeJS.ProcessEnv {
  return {
    JWT_SECRET: TEST_JWT_SECRET,
    COMPANY_TZ: 'Asia/Bishkek',
    ...extra,
  };
}

export function testModule(extra: TestEnv = {}): TestingModuleBuilder {
  // PrismaModule читает DATABASE_URL из process.env при создании
  process.env.DATABASE_URL ??= DATABASE_URL;
  // Фоновые опрос outbox и проходы планировщика выключены: тесты вызывают
  // OutboxDispatcher.runOnce() и ReminderScheduler.pass() сами (детерминизм)
  const idle = { onApplicationBootstrap() {}, onModuleDestroy() {} };
  return Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
    .overrideProvider(APP_ENV)
    .useValue(testEnv(extra))
    .overrideProvider(OutboxWorker)
    .useValue(idle)
    .overrideProvider(ReminderWorker)
    .useValue(idle);
}

export async function createTestApp(
  extra: TestEnv = {},
  customize: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<INestApplication> {
  const moduleRef = await customize(testModule(extra)).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return app;
}
