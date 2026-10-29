// e2e:reset (ROADMAP §0 «Изоляция e2e»): сброс данных БД и очистка Mailpit без перезапуска API.
// TRUNCATE всех таблиц приложения, кроме _prisma_migrations; схема и соединения API не затрагиваются.
// После TRUNCATE выполняется seed 11 демо-пользователей (S3).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://leave:leave@127.0.0.1:5432/leave';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

export async function resetDb() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );
    if (rows.length > 0) {
      const list = rows.map((r) => `"public"."${r.tablename.replaceAll('"', '""')}"`).join(', ');
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}

export async function resetMailpit() {
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Mailpit DELETE /api/v1/messages: ${res.status}`);
}

// Демо-часы после сброса: фиксированный момент, чтобы результаты e2e не зависели от даты запуска
// (RULES §9-6). 2026-10-21 09:00 по Бишкеку (UTC+6) — дата из README для демо. Сценарий,
// которому нужна другая дата, ставит часы сам. Часы выставляются до seed: от них зависит accessGranted.
export const E2E_CLOCK = '2026-10-21T03:00:00Z';

export async function setClock(instant = E2E_CLOCK) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO "ClockState" (id, instant) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET instant = EXCLUDED.instant, "updatedAt" = now()`,
      [instant],
    );
  } finally {
    await client.end();
  }
}

// Seed лежит в образе api, e2e идёт на хосте (DECISIONS 2026-10-24 22:28). Запуск из корня репозитория.
export function seedDb() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const res = spawnSync('docker', ['compose', 'exec', '-T', 'api', 'node', 'dist/seed.js'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `seed не выполнен (запущен ли docker compose up, контейнер api?): ${res.stderr || res.error || res.status}`,
    );
  }
}

export async function resetAll() {
  await resetDb();
  await setClock();
  seedDb();
  await resetMailpit();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await resetAll();
  console.log('e2e:reset OK');
}
