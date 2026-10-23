import { defineConfig } from '@playwright/test';

// Изоляция e2e (ROADMAP §0): БД, Mailpit и демо-часы общие, поэтому сценарии идут строго по одному.
// Стек (docker compose up) поднимает Пользователь локально или джоба CI; webServer не нужен.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
  },
});
