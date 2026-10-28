// seed:demo (ROADMAP S5, issue S5-c): демо-заявки через обычные подачу и решение, даты от Clock.
// Сервисы собираются без Nest, как в seed: OutboxWorker в этом процессе не поднимается, письма
// только ставятся в outbox, доставляет их воркер api. Действия выполняются от имени автора и
// согласующего: вход не нужен, это допустимо только в демо-команде (DEMO_MODE=true).
import { ApprovalsService } from './approvals/approvals.service';
import { VacationApprovedHook } from './approvals/vacation-approved.hook';
import type { AuthUser } from './auth/auth-user';
import { PrismaAuthUsers } from './auth/prisma-auth-users';
import { BalanceService } from './balance/balance.service';
import { Clock } from './clock/clock';
import { companyToday, companyTz } from './clock/company-tz';
import { DbClock } from './clock/db-clock';
import { ApiError } from './common/problem';
import { isDemoMode } from './config/app-config';
import { EventBus } from './events/event-bus';
import { VacationStatus } from './generated/prisma/enums';
import { OrgService } from './org/org.service';
import { PrismaService } from './prisma/prisma.service';
import {
  DEMO_MARKER,
  DEMO_SCENARIOS,
  demoPeriods,
  type DemoPeriod,
} from './seed-demo-data';
import { VacationsService } from './vacations/vacations.service';

export interface DemoServices {
  vacations: VacationsService;
  approvals: ApprovalsService;
}

/** Те же сервисы, что в api (architecture §4), без Nest. */
export function demoServices(
  db: PrismaService,
  clock: Clock,
  env: NodeJS.ProcessEnv,
): DemoServices {
  const org = new OrgService(db);
  const balance = new BalanceService(db, clock, env);
  return {
    vacations: new VacationsService(db, org, balance, clock, env),
    approvals: new ApprovalsService(
      db,
      org,
      balance,
      clock,
      new EventBus(),
      new VacationApprovedHook(),
      env,
    ),
  };
}

export interface SeedDemoReport {
  created: string[];
  existing: string[];
  decided: string[];
  skipped: { author: string; reason: string }[];
}

export async function runSeedDemo(
  db: PrismaService,
  clock: Clock,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedDemoReport> {
  // RULES §9-2: даты от демо-часов; без флага часы системные, сценарии не воспроизводятся
  if (!isDemoMode(env)) {
    throw new Error(
      'seed:demo: работает только в демо-режиме (DEMO_MODE=true)',
    );
  }
  const users = await loadUsers(db);
  const today = companyToday(await clock.now(), companyTz(env));
  const { vacations, approvals } = demoServices(db, clock, env);
  const report: SeedDemoReport = {
    created: [],
    existing: [],
    decided: [],
    skipped: [],
  };

  for (const period of demoPeriods(today)) {
    const { author, decision } = period.scenario;
    const user = users.get(author)!;
    try {
      const found = await findDemo(db, user.id);
      const demo = found
        ? { ...found, created: false }
        : await submitOrFind(db, vacations, user, users, period);
      (demo.created ? report.created : report.existing).push(author);
      if (decision && demo.status === VacationStatus.PENDING) {
        try {
          await approvals.decide(
            users.get(decision.by)!,
            demo.id,
            decision.kind,
            decision.comment,
          );
          report.decided.push(author);
        } catch (e) {
          // RULES §10-1: решение уже принято (параллельный запуск) — шаг выполнен
          if (!(e instanceof ApiError && e.code === 'ALREADY_PROCESSED')) {
            throw e;
          }
        }
      }
    } catch (e) {
      // отказ проверки (§3, §4): сценарий пропускается, остальные выполняются
      if (!(e instanceof ApiError)) throw e;
      report.skipped.push({ author, reason: e.message });
    }
  }
  return report;
}

const neededLogins = () =>
  new Set(
    DEMO_SCENARIOS.flatMap((s) => [
      s.author,
      s.backstopper,
      ...(s.decision ? [s.decision.by] : []),
    ]),
  );

async function loadUsers(db: PrismaService): Promise<Map<string, AuthUser>> {
  const logins = [...neededLogins()];
  const rows = await db.user.findMany({
    where: { login: { in: logins } },
    select: { id: true },
  });
  const auth = new PrismaAuthUsers(db);
  const users = new Map<string, AuthUser>();
  for (const { id } of rows) {
    const u = (await auth.findById(id))!;
    users.set(u.login, u);
  }
  const missing = logins.filter((l) => !users.has(l));
  if (missing.length > 0) {
    throw new Error(
      `seed:demo: нет пользователей seed (${missing.join(', ')}), сначала выполните seed`,
    );
  }
  return users;
}

/** Заявка сценария: автор и метка в комментарии; любая, в том числе отменённая. */
function findDemo(db: PrismaService, employeeId: number) {
  return db.vacation.findFirst({
    where: { employeeId, comment: DEMO_MARKER },
    orderBy: { id: 'asc' },
    select: { id: true, status: true },
  });
}

/** Подача; если её опередил параллельный запуск (отказ §3-4 п.3), берётся его заявка. */
async function submitOrFind(
  db: PrismaService,
  vacations: VacationsService,
  user: AuthUser,
  users: Map<string, AuthUser>,
  { scenario, startDate, endDate }: DemoPeriod,
) {
  try {
    const v = await vacations.submit(user, {
      startDate,
      endDate,
      backstopperId: users.get(scenario.backstopper)!.id,
      comment: DEMO_MARKER,
    });
    return { id: v.id, status: v.status, created: true };
  } catch (e) {
    const raced = await findDemo(db, user.id);
    if (raced) return { ...raced, created: false };
    throw e;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('seed:demo: не задан DATABASE_URL');
  const db = new PrismaService(url);
  try {
    const report = await runSeedDemo(db, new DbClock(db), process.env);
    console.log(
      `seed:demo: создано ${report.created.length}, уже было ${report.existing.length}, решено ${report.decided.length}`,
    );
    for (const s of report.skipped) {
      console.error(`seed:demo: сценарий ${s.author} пропущен: ${s.reason}`);
    }
    if (report.skipped.length > 0) process.exitCode = 1;
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
