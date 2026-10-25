// Идемпотентный seed 11 демо-пользователей (RULES §7). Создаёт только недостающих;
// hireDate, passwordHash и прочие поля существующих не трогает, а признак «доступ получен»
// может только поднять (RULES §6-7, DECISIONS 2026-10-24 22:28).
// Всё в одной транзакции: нарушенный инвариант откатывает создание, api не остаётся с половиной данных.
import { PrismaPg } from '@prisma/adapter-pg';
import { hashPassword } from './auth/password';
import { isDemoMode } from './config/app-config';
import { Clock, SystemClock } from './clock/clock';
import { companyToday, companyTz } from './clock/company-tz';
import { DbClock } from './clock/db-clock';
import { PrismaClient } from './generated/prisma/client';
import {
  DEMO_PASSWORD,
  SEED_USERS,
  assertOrgInvariants,
  shouldGrantAccess,
} from './seed-data';

/** Часы seed: в демо-режиме из БД, иначе системные (RULES §9-2). */
export function seedClock(db: PrismaClient, env: NodeJS.ProcessEnv): Clock {
  return isDemoMode(env) ? new DbClock(db) : new SystemClock();
}

export async function runSeed(
  db: PrismaClient,
  clock: Clock,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const today = companyToday(await clock.now(), companyTz(env));

  // bcrypt медленный: хеш считается только для отсутствующих пользователей
  const existing = new Set(
    (await db.user.findMany({ select: { login: true } })).map((x) => x.login),
  );
  const hashes = new Map<string, string>();
  for (const user of SEED_USERS) {
    if (!existing.has(user.login)) {
      hashes.set(user.login, await hashPassword(DEMO_PASSWORD));
    }
  }

  await db.$transaction(async (tx) => {
    const ids = new Map<string, number>();
    for (const user of SEED_USERS) {
      const passwordHash = hashes.get(user.login);
      if (passwordHash) {
        // skipDuplicates: параллельный seed (старт api и e2e:reset) не падает на UNIQUE
        await tx.user.createMany({
          data: [
            {
              login: user.login,
              email: `${user.login}@vacation.local`,
              passwordHash,
              fullName: user.fullName,
              hireDate: new Date(`${user.hireDate}T00:00:00Z`),
              managerId: user.managerLogin ? ids.get(user.managerLogin) : null,
              isHr: user.isHr,
              teamName: user.teamName,
              accessGranted: shouldGrantAccess(user.hireDate, today),
            },
          ],
          skipDuplicates: true,
        });
      }
      const row = await tx.user.findUnique({
        where: { login: user.login },
        select: { id: true, hireDate: true },
      });
      if (!row) {
        // skipDuplicates глотает и конфликт других UNIQUE (email, единственный корень)
        throw new Error(
          `seed: пользователь ${user.login} не создан, в БД есть конфликтующие данные (чужой директор или email)`,
        );
      }
      ids.set(user.login, row.id);
      if (!hashes.has(user.login)) {
        // существующий: признак только поднимается, по дате выхода из БД (её мог сменить HR)
        const hired = row.hireDate.toISOString().slice(0, 10);
        if (shouldGrantAccess(hired, today)) {
          await tx.user.updateMany({
            where: { id: row.id, accessGranted: false },
            data: { accessGranted: true },
          });
        }
      }
    }
    assertOrgInvariants({
      withoutManager: await tx.user.count({ where: { managerId: null } }),
      hr: await tx.user.count({ where: { isHr: true } }),
    });
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('seed: не задан DATABASE_URL');
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    await runSeed(db, seedClock(db, process.env));
    console.log(`seed: готово (${SEED_USERS.length} пользователей)`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
