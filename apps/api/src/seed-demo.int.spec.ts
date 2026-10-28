import { Pool } from 'pg';
import { PrismaAuthUsers } from './auth/prisma-auth-users';
import { FakeClock } from './clock/clock';
import { DbClock } from './clock/db-clock';
import { PrismaService } from './prisma/prisma.service';
import { runSeed } from './seed';
import { demoServices, runSeedDemo } from './seed-demo';
import { DEMO_MARKER } from './seed-demo-data';
import { setDbClock } from './testing/int-helpers';
import {
  DATABASE_URL,
  createPool,
  insertVacation,
  truncateAll,
} from './testing/test-db';

// 2026-10-21 09:00 в Бишкеке (UTC+6): шаг README «выставить часы на 2026-10-21»
const AT = '2026-10-21T03:00:00Z';
const LATER = '2026-11-03T03:00:00Z';
const DEMO = { DEMO_MODE: 'true' };

interface VacationRow {
  login: string;
  start: string;
  end: string;
  status: string;
  backstopper: string;
  comment: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionComment: string | null;
  createdAt: Date;
}

interface MailRow {
  type: string;
  vacationOf: string;
  recipient: string;
  createdAt: Date;
  subject: string;
  body: string;
}

describe('seed:demo (integration, нужен Postgres)', () => {
  let pool: Pool;
  let prisma: PrismaService;

  const demoAt = (instant: string) =>
    runSeedDemo(prisma, new FakeClock(instant), DEMO);

  const vacations = async (): Promise<VacationRow[]> =>
    (
      await pool.query<VacationRow>(
        `SELECT e.login, to_char(v."startDate", 'YYYY-MM-DD') AS start,
                to_char(v."endDate", 'YYYY-MM-DD') AS "end", v.status::text AS status,
                b.login AS backstopper, v.comment, d.login AS "decidedBy", v."decidedAt",
                v."decisionComment", v."createdAt"
         FROM "Vacation" v JOIN "User" e ON e.id = v."employeeId"
         JOIN "User" b ON b.id = v."backstopperId"
         LEFT JOIN "User" d ON d.id = v."decidedById" ORDER BY v.id`,
      )
    ).rows;

  const mails = async (): Promise<MailRow[]> =>
    (
      await pool.query<MailRow>(
        `SELECT o.type::text AS type, e.login AS "vacationOf", r.login AS recipient,
                o."createdAt", o.subject, o.body
         FROM "OutboxMessage" o JOIN "User" r ON r.id = o."recipientId"
         JOIN "Vacation" v ON v.id = o."vacationId" JOIN "User" e ON e.id = v."employeeId"
         ORDER BY o.id`,
      )
    ).rows;

  const ledger = async () =>
    (
      await pool.query<{
        login: string;
        kind: string;
        halfDays: number;
        occurredAt: Date;
      }>(
        `SELECT e.login, l.kind::text AS kind, l."halfDays", l."occurredAt"
         FROM "LedgerEntry" l JOIN "Vacation" v ON v.id = l."vacationId"
         JOIN "User" e ON e.id = v."employeeId" ORDER BY l.id`,
      )
    ).rows;

  const counts = async () => ({
    vacations: (await vacations()).length,
    ledger: (await ledger()).length,
    mails: (await mails()).length,
  });

  const userId = async (login: string) =>
    (
      await pool.query<{ id: number }>(
        `SELECT id FROM "User" WHERE login = $1`,
        [login],
      )
    ).rows[0].id;

  const pendingFor = async (login: string) => {
    const viewer = (await new PrismaAuthUsers(prisma).findById(
      await userId(login),
    ))!;
    return demoServices(prisma, new FakeClock(AT), DEMO).approvals.pending(
      viewer,
    );
  };

  beforeAll(() => {
    pool = createPool();
    prisma = new PrismaService(DATABASE_URL);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await runSeed(prisma, new FakeClock(AT));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  // RULES §4-1, §4-2, §4-6, §7-5: состав, даты, статусы и согласующие
  it('создаёт 7 заявок по сценариям issue', async () => {
    const report = await demoAt(AT);
    expect(report.skipped).toEqual([]);
    const rows = (await vacations()).map((v) => [
      v.login,
      v.start,
      v.end,
      v.status,
      v.backstopper,
      v.decidedBy,
    ]);
    expect(rows).toEqual([
      ['margaret', '2026-11-09', '2026-11-13', 'PENDING', 'thomas', null],
      ['emily', '2026-11-16', '2026-11-20', 'PENDING', 'daniel', null],
      ['james', '2026-11-09', '2026-11-13', 'APPROVED', 'sophie', 'daniel'],
      ['sophie', '2026-11-11', '2026-11-17', 'PENDING', 'liam', null],
      ['grace', '2026-11-16', '2026-11-20', 'PENDING', 'henry', null],
      ['henry', '2026-11-23', '2026-11-27', 'APPROVED', 'grace', 'olivia'],
      ['chloe', '2026-11-16', '2026-11-20', 'REJECTED', 'grace', 'olivia'],
    ]);
    const all = await vacations();
    expect(all.every((v) => v.comment === DEMO_MARKER)).toBe(true);
  });

  // RULES §4-1: комментарий согласующего только у отклонённой chloe
  it('комментарий решения у chloe', async () => {
    await demoAt(AT);
    const byLogin = new Map((await vacations()).map((v) => [v.login, v]));
    expect(byLogin.get('chloe')!.decisionComment).toBe(
      'Пересекается с релизом команды',
    );
    expect(byLogin.get('james')!.decisionComment).toBeNull();
  });

  // RULES §3-6, §7-5: у Сотрудника 3 заявок нет
  it('у liam заявок нет', async () => {
    await demoAt(AT);
    expect((await vacations()).map((v) => v.login)).not.toContain('liam');
  });

  // RULES §4-2, §4-1, §4-6, §4-7: очереди согласующих и предупреждения о пересечениях
  it('очереди emily, thomas, daniel, olivia', async () => {
    await demoAt(AT);
    const queue = async (login: string) =>
      (await pendingFor(login)).map((i) => ({
        who: i.vacation.employee.id,
        overlaps: i.overlaps.map((o) => o.employee.id),
        canApprove: i.canApprove,
      }));
    expect(await queue('emily')).toEqual([
      { who: await userId('margaret'), overlaps: [], canApprove: true },
    ]);
    expect(await queue('thomas')).toEqual([
      { who: await userId('emily'), overlaps: [], canApprove: true },
    ]);
    expect(await queue('daniel')).toEqual([
      {
        who: await userId('sophie'),
        overlaps: [await userId('james')],
        canApprove: true,
      },
    ]);
    expect(await queue('olivia')).toEqual([
      { who: await userId('grace'), overlaps: [], canApprove: true },
    ]);
  });

  // RULES §4-4, §9-1: одно DEBIT на весь отпуск у одобренных, момент по Clock
  it('журнал: DEBIT у james и henry, у chloe нет', async () => {
    await demoAt(AT);
    expect(await ledger()).toEqual([
      { login: 'james', kind: 'DEBIT', halfDays: 10, occurredAt: new Date(AT) },
      { login: 'henry', kind: 'DEBIT', halfDays: 10, occurredAt: new Date(AT) },
    ]);
  });

  // RULES §8-2, §8-6, §3-3: письма только от подачи и решения
  it('10 писем: 7 NEW_REQUEST и 3 DECISION', async () => {
    await demoAt(AT);
    const got = (await mails()).map((m) => [m.type, m.vacationOf, m.recipient]);
    expect(got).toEqual([
      ['NEW_REQUEST', 'margaret', 'emily'],
      ['NEW_REQUEST', 'emily', 'thomas'],
      ['NEW_REQUEST', 'james', 'daniel'],
      ['DECISION', 'james', 'james'],
      ['NEW_REQUEST', 'sophie', 'daniel'],
      ['NEW_REQUEST', 'grace', 'olivia'],
      ['NEW_REQUEST', 'henry', 'olivia'],
      ['DECISION', 'henry', 'henry'],
      ['NEW_REQUEST', 'chloe', 'olivia'],
      ['DECISION', 'chloe', 'chloe'],
    ]);
  });

  // RULES §3-3, §8-6: backstopper писем не получает; HR — только о заявке директора
  it('нет писем backstopper и HR, кроме NEW_REQUEST директора', async () => {
    await demoAt(AT);
    const all = await mails();
    const toEmily = all.filter((m) => m.recipient === 'emily');
    expect(toEmily.map((m) => [m.type, m.vacationOf])).toEqual([
      ['NEW_REQUEST', 'margaret'],
    ]);
    for (const v of await vacations()) {
      expect(
        all.filter(
          (m) => m.vacationOf === v.login && m.recipient === v.backstopper,
        ),
      ).toEqual([]);
    }
  });

  // RULES §8-2, §4-1: письмо об отклонении с комментарием согласующего
  it('DECISION chloe: отклонена, с комментарием', async () => {
    await demoAt(AT);
    const chloe = (await mails()).find(
      (m) => m.type === 'DECISION' && m.recipient === 'chloe',
    )!;
    expect(chloe.subject).toMatch(/отклонена/);
    expect(chloe.body).toContain('Пересекается с релизом команды');
  });

  // RULES §9-1: заявки, решения и письма — момент Clock
  it('createdAt, decidedAt и письма по Clock', async () => {
    await demoAt(AT);
    for (const v of await vacations()) {
      expect(v.createdAt).toEqual(new Date(AT));
      if (v.decidedBy) expect(v.decidedAt).toEqual(new Date(AT));
    }
    for (const m of await mails()) expect(m.createdAt).toEqual(new Date(AT));
  });

  // RULES §9-1, §9-2: «сегодня» из демо-часов в БД
  it('с DbClock даты от ClockState', async () => {
    await setDbClock(pool, '2026-11-30T03:00:00Z'); // M + 18 через Новый год → январь
    await runSeedDemo(prisma, new DbClock(prisma), DEMO);
    const james = (await vacations()).find((v) => v.login === 'james')!;
    expect([james.start, james.end]).toEqual(['2027-01-04', '2027-01-08']);
    expect(james.createdAt).toEqual(new Date('2026-11-30T03:00:00Z'));
  });

  // RULES §10-1, §8-3: повторный запуск ничего не дублирует, в том числе после сдвига часов
  it('повторный запуск: те же строки', async () => {
    await demoAt(AT);
    const before = {
      v: await vacations(),
      l: await ledger(),
      m: await mails(),
    };
    const again = await demoAt(AT);
    expect(again.created).toEqual([]);
    expect(again.decided).toEqual([]);
    expect(again.skipped).toEqual([]);
    await demoAt(LATER);
    expect({
      v: await vacations(),
      l: await ledger(),
      m: await mails(),
    }).toEqual(before);
  });

  // RULES §10-1: параллельные запуски дают тот же результат
  it('два параллельных запуска: без дублей', async () => {
    const [a, b] = await Promise.all([demoAt(AT), demoAt(AT)]);
    expect([...a.skipped, ...b.skipped]).toEqual([]);
    expect(await counts()).toEqual({ vacations: 7, ledger: 2, mails: 10 });
    // каждая заявка засчитана как созданная ровно одним запуском
    expect([...a.created, ...b.created].sort()).toEqual([
      'chloe',
      'emily',
      'grace',
      'henry',
      'james',
      'margaret',
      'sophie',
    ]);
  });

  // RULES §10-1, §4-4: заявка сценария осталась «На согласовании» — повторный запуск решает
  it('частичное состояние: PENDING доводится до одобрения и отклонения', async () => {
    await demoAt(AT);
    // откат решений james и chloe: заявки снова «На согласовании», без списания и письма
    const undo = `(SELECT v.id FROM "Vacation" v JOIN "User" u ON u.id = v."employeeId"
                   WHERE u.login IN ('james', 'chloe'))`;
    await pool.query(
      `DELETE FROM "OutboxMessage" WHERE type = 'DECISION' AND "vacationId" IN ${undo}`,
    );
    await pool.query(`DELETE FROM "LedgerEntry" WHERE "vacationId" IN ${undo}`);
    await pool.query(
      `UPDATE "Vacation" SET status = 'PENDING', "decidedById" = NULL, "decidedAt" = NULL,
              "decisionComment" = NULL
       WHERE id IN ${undo}`,
    );
    const report = await demoAt(AT);
    expect(report.decided).toEqual(['james', 'chloe']);
    const status = new Map((await vacations()).map((v) => [v.login, v.status]));
    expect(status.get('james')).toBe('APPROVED');
    expect(status.get('chloe')).toBe('REJECTED');
    expect(await counts()).toEqual({ vacations: 7, ledger: 2, mails: 10 });
  });

  // RULES §3-4 п.3: у автора своя заявка на эти даты — сценарий пропущен, остальные идут
  it('отказ проверки: сценарий пропущен с причиной', async () => {
    await insertVacation(pool, {
      employeeId: await userId('grace'),
      backstopperId: await userId('henry'),
      start: '2026-11-16',
      end: '2026-11-20',
    });
    const report = await demoAt(AT);
    expect(report.skipped.map((s) => s.author)).toEqual(['grace']);
    expect(report.skipped[0].reason).toMatch(/уже есть заявка на эти даты/);
    const demo = (await vacations()).filter((v) => v.comment === DEMO_MARKER);
    expect(demo.map((v) => v.login)).toEqual([
      'margaret',
      'emily',
      'james',
      'sophie',
      'henry',
      'chloe',
    ]);
  });

  // RULES §9-2: без демо-режима ничего не создаётся, часы не трогаются
  it('без DEMO_MODE — ошибка', async () => {
    await expect(runSeedDemo(prisma, new DbClock(prisma), {})).rejects.toThrow(
      /DEMO_MODE=true/,
    );
    expect(await counts()).toEqual({ vacations: 0, ledger: 0, mails: 0 });
    const { rows } = await pool.query(`SELECT 1 FROM "ClockState"`);
    expect(rows).toHaveLength(0);
  });

  // RULES §7-5: без пользователей seed — ошибка «сначала seed»
  it('без пользователей seed — ошибка', async () => {
    await truncateAll(pool);
    await expect(demoAt(AT)).rejects.toThrow(/сначала выполните seed/);
    expect(await counts()).toEqual({ vacations: 0, ledger: 0, mails: 0 });
  });
});
