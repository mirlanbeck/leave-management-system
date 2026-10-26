// Фабрика тестового приложения: тот же AppModule, что и в проде (guard, фильтр и пайп приходят
// из модулей), подменяется только окружение. Не попадает в сборку (tsconfig.build.json).
import { INestApplication } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { APP_ENV } from '../config/app-config';
import { OutboxWorker } from '../mail/outbox-worker';
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
  // Фоновый опрос outbox выключен: тесты вызывают OutboxDispatcher.runOnce() сами (детерминизм)
  return Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
    .overrideProvider(APP_ENV)
    .useValue(testEnv(extra))
    .overrideProvider(OutboxWorker)
    .useValue({ onApplicationBootstrap() {}, onModuleDestroy() {} });
}

export async function createTestApp(
  extra: TestEnv = {},
  customize: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<INestApplication> {
  const moduleRef = await customize(testModule(extra)).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}
