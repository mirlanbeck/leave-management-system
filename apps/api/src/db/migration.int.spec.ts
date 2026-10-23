// Миграции на пустой БД (S1). Создаёт временную базу, применяет `prisma migrate deploy`.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Pool } from 'pg';
import { DATABASE_URL, createPool } from './test-db';

describe('миграции на пустой БД (integration)', () => {
  const dbName = `migration_check_${process.pid}`;
  let admin: Pool;
  let fresh: Pool;

  beforeAll(async () => {
    admin = createPool();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${dbName}`;
    const prismaCli = require.resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'pipe',
    });
    fresh = createPool(url.toString());
  }, 60_000);

  afterAll(async () => {
    await fresh?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  });

  const names = async (sql: string): Promise<string[]> =>
    (await fresh.query<{ n: string }>(sql)).rows.map((r) => r.n).sort();

  it('создаёт таблицы приложения и удаляет временную AppMeta', async () => {
    // RULES §6-6: журнал, outbox, состояние часов; ROADMAP S1: AppMeta убирает S1
    expect(
      await names(
        `SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`,
      ),
    ).toEqual([
      'ClockState',
      'LedgerEntry',
      'OutboxMessage',
      'User',
      'Vacation',
      '_prisma_migrations',
    ]);
  });

  it('создаёт ограничения, индексы и триггер из сырого SQL', async () => {
    // RULES §3-4, §5-2, §6-8, §7-1, §8-3, §9-2: ограничения не потерялись в миграции
    expect(
      await names(
        `SELECT extname AS n FROM pg_extension WHERE extname = 'btree_gist'`,
      ),
    ).toEqual(['btree_gist']);
    const constraints = await names(
      `SELECT conname AS n FROM pg_constraint WHERE conname ~ '_(chk|excl)$'`,
    );
    expect(constraints).toEqual([
      'ClockState_single_row_chk',
      'LedgerEntry_kind_shape_chk',
      'OutboxMessage_attempts_chk',
      'User_not_own_manager_chk',
      'Vacation_backstopper_not_self_chk',
      'Vacation_dates_order_chk',
      'Vacation_no_approved_overlap_excl',
      'Vacation_not_replaces_self_chk',
      'Vacation_one_year_chk',
      'Vacation_work_days_chk',
    ]);
    expect(
      await names(
        `SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public'
         AND indexname IN ('User_single_root_idx', 'Vacation_single_live_successor_idx',
           'LedgerEntry_one_debit_per_vacation_idx', 'LedgerEntry_one_refund_per_vacation_idx',
           'OutboxMessage_type_vacationId_recipientId_key')`,
      ),
    ).toHaveLength(5);
    expect(
      await names(
        `SELECT tgname AS n FROM pg_trigger WHERE tgname = 'LedgerEntry_refund_guard'`,
      ),
    ).toEqual(['LedgerEntry_refund_guard']);
  });
});
