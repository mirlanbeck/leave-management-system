import pg from 'pg';
import { test, expect } from './fixtures';
import { resetAll } from './reset.mjs';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://leave:leave@127.0.0.1:5432/leave';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
const API_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080';

// RULES §8-1: Mailpit и Postgres поднимаются вместе со стеком; ROADMAP, раздел 0 «Изоляция e2e»:
// e2e:reset два раза подряд, API после сброса отвечает без перезапуска.
test('e2e:reset дважды подряд чистит БД и Mailpit, API отвечает без перезапуска', async ({ request }) => {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    // Своя таблица, чтобы тест не зависел от временной AppMeta (её убирает S1).
    await db.query('CREATE TABLE IF NOT EXISTS e2e_reset_probe (v text)');
    const migrations = Number((await db.query('SELECT count(*) FROM _prisma_migrations')).rows[0].count);
    expect(migrations).toBeGreaterThan(0);

    for (let run = 1; run <= 2; run++) {
      await db.query("INSERT INTO e2e_reset_probe VALUES ('marker')");
      const send = await request.post(`${MAILPIT_URL}/api/v1/send`, {
        data: {
          From: { Email: 'from@example.com' },
          To: [{ Email: 'to@example.com' }],
          Subject: `probe ${run}`,
          Text: 'probe',
        },
      });
      expect(send.ok()).toBe(true);
      const before = await (await request.get(`${MAILPIT_URL}/api/v1/messages`)).json();
      expect(before.total).toBeGreaterThan(0);

      await resetAll();

      expect(Number((await db.query('SELECT count(*) FROM e2e_reset_probe')).rows[0].count)).toBe(0);
      const after = await (await request.get(`${MAILPIT_URL}/api/v1/messages`)).json();
      expect(after.total).toBe(0);
      expect(Number((await db.query('SELECT count(*) FROM _prisma_migrations')).rows[0].count)).toBe(migrations);
      const health = await request.get(`${API_URL}/api/health`);
      expect(health.status()).toBe(200);
    }
  } finally {
    await db.query('DROP TABLE IF EXISTS e2e_reset_probe');
    await db.end();
  }
});
