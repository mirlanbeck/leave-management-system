// Помощники integration-тестов БД (S1): пул pg, очистка, фабрики строк, разбор ошибок Postgres.
// Ограничения проверяются сырым SQL через pg, чтобы тест видел SQLSTATE и имя ограничения,
// а не обёртку Prisma. Даты передаются строками 'YYYY-MM-DD' (календарные даты, RULES §1).
import { Pool } from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://leave:leave@127.0.0.1:5432/leave';

export type Db = Pick<Pool, 'query'>;

export function createPool(url: string = DATABASE_URL): Pool {
  return new Pool({ connectionString: url, max: 5 });
}

/** TRUNCATE всех таблиц приложения, как e2e:reset (кроме _prisma_migrations). */
export async function truncateAll(db: Db): Promise<void> {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await db.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

let seq = 0;

export interface NewUser {
  managerId: number | null;
  login?: string;
  hireDate?: string;
  isHr?: boolean;
  teamName?: string | null;
}

export async function insertUser(db: Db, u: NewUser): Promise<number> {
  seq += 1;
  const login = u.login ?? `user${seq}`;
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "User" (login, email, "passwordHash", "fullName", "hireDate", "managerId", "isHr", "teamName")
     VALUES ($1, $2, 'hash', $3, $4, $5, $6, $7) RETURNING id`,
    [
      login,
      `${login}@vacation.local`,
      `Сотрудник ${login}`,
      u.hireDate ?? '2022-03-15',
      u.managerId,
      u.isHr ?? false,
      u.teamName ?? null,
    ],
  );
  return rows[0].id;
}

export interface Org {
  director: number;
  manager: number;
  employee: number;
  other: number;
}

/** Мини-структура: директор <- руководитель <- два сотрудника. */
export async function seedOrg(db: Db): Promise<Org> {
  const director = await insertUser(db, { managerId: null, login: 'director' });
  const manager = await insertUser(db, {
    managerId: director,
    login: 'manager',
  });
  const employee = await insertUser(db, {
    managerId: manager,
    login: 'employee',
  });
  const other = await insertUser(db, { managerId: manager, login: 'other' });
  return { director, manager, employee, other };
}

export interface NewVacation {
  employeeId: number;
  backstopperId: number;
  start: string;
  end: string;
  workDays?: number;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REPLACED';
  replacesId?: number | null;
}

export async function insertVacation(db: Db, v: NewVacation): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "Vacation" ("employeeId", "backstopperId", "startDate", "endDate", "workDays",
                             status, "replacesId", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6::"VacationStatus", $7, '2026-10-01T03:00:00Z') RETURNING id`,
    [
      v.employeeId,
      v.backstopperId,
      v.start,
      v.end,
      v.workDays ?? 5,
      v.status ?? 'PENDING',
      v.replacesId ?? null,
    ],
  );
  return rows[0].id;
}

export interface NewLedger {
  kind: 'DEBIT' | 'REFUND';
  vacationId: number;
  halfDays: number;
  refundOfId?: number | null;
  occurredAt?: string;
}

export async function insertLedger(db: Db, e: NewLedger): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "LedgerEntry" (kind, "vacationId", "refundOfId", "halfDays", "occurredAt")
     VALUES ($1::"LedgerKind", $2, $3, $4, $5) RETURNING id`,
    [
      e.kind,
      e.vacationId,
      e.refundOfId ?? null,
      e.halfDays,
      e.occurredAt ?? '2026-10-05T03:00:00Z',
    ],
  );
  return rows[0].id;
}

export async function insertMail(
  db: Db,
  m: {
    type: 'NEW_REQUEST' | 'DECISION' | 'REMINDER';
    vacationId: number;
    recipientId: number;
  },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "OutboxMessage" (type, "vacationId", "recipientId", subject, body, "createdAt")
     VALUES ($1::"MailType", $2, $3, 'тема', 'текст', '2026-10-05T03:00:00Z') RETURNING id`,
    [m.type, m.vacationId, m.recipientId],
  );
  return rows[0].id;
}

export interface PgFailure {
  code: string;
  constraint?: string;
  message: string;
}

/** Ждёт ошибку Postgres и возвращает SQLSTATE, имя ограничения и сообщение. */
export async function pgFailure(op: Promise<unknown>): Promise<PgFailure> {
  try {
    await op;
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message: string };
    if (typeof err.code === 'string') {
      return {
        code: err.code,
        constraint: err.constraint,
        message: err.message,
      };
    }
    throw e;
  }
  throw new Error('ожидалась ошибка Postgres, но запрос выполнился');
}

/** Корень цепочки переносов (RULES §5-12): заявка без replacesId. UNION: цикл не зациклит запрос. */
export async function findChainRoot(
  db: Db,
  vacationId: number,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id, "replacesId" FROM "Vacation" WHERE id = $1
       UNION
       SELECT v.id, v."replacesId" FROM "Vacation" v JOIN chain c ON v.id = c."replacesId"
     )
     SELECT id FROM chain WHERE "replacesId" IS NULL`,
    [vacationId],
  );
  if (rows.length !== 1) {
    throw new Error(`у заявки ${vacationId} нет единственного корня цепочки`);
  }
  return rows[0].id;
}
