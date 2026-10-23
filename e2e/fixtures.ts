import { test as base } from '@playwright/test';
import { resetAll } from './reset.mjs';

// Каждый сценарий начинается с чистых БД и Mailpit (ROADMAP §0 «Изоляция e2e»).
export const test = base.extend<{ cleanState: void }>({
  cleanState: [
    async ({}, use) => {
      await resetAll();
      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
