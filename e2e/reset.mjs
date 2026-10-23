// e2e:reset (ROADMAP §0 «Изоляция e2e»): сброс данных БД и очистка Mailpit без перезапуска API.
// TRUNCATE всех таблиц приложения, кроме _prisma_migrations; схема и соединения API не затрагиваются.
// До S3 seed нет: точка подключения помечена ниже.
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://leave:leave@127.0.0.1:5432/leave';
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

export async function resetAll() {
  await resetDb();
  // TODO S3: seed (пользователи, структура команд) после TRUNCATE.
  await resetMailpit();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await resetAll();
  console.log('e2e:reset OK');
}
