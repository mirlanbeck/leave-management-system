// Запуск integration-тестов на отдельной БД (по умолчанию leave_test), не на рабочей leave:
// тесты делают TRUNCATE и не должны стирать демо-данные запущенного стека.
// БД создаётся при отсутствии (подходит и для существующего тома Postgres), затем миграции и jest.
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const url = new URL(
  process.env.TEST_DATABASE_URL ??
    'postgresql://leave:leave@127.0.0.1:5432/leave_test',
);
const dbName = decodeURIComponent(url.pathname.slice(1));
if (!dbName.endsWith('_test')) {
  console.error(
    `test:int: имя тестовой БД должно оканчиваться на _test, получено "${dbName}"`,
  );
  process.exit(1);
}

const admin = new pg.Client({
  connectionString: Object.assign(new URL(url), {
    pathname: '/postgres',
  }).toString(),
});
await admin.connect();
try {
  const { rowCount } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName],
  );
  if (rowCount === 0)
    await admin.query(`CREATE DATABASE "${dbName.replaceAll('"', '""')}"`);
} finally {
  await admin.end();
}

const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  NODE_OPTIONS: [process.env.NODE_OPTIONS, '--experimental-vm-modules']
    .filter(Boolean)
    .join(' '),
};
const run = (cmd) => {
  const res = spawnSync(cmd, { env, stdio: 'inherit', shell: true });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

run('npx prisma generate');
run('npx prisma migrate deploy');
const extra = process.argv.slice(2).join(' ');
run(
  `npx jest --runInBand --testTimeout=30000 --testRegex "\\.int\\.spec\\.ts$" ${extra}`,
);
