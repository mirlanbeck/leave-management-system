// Типы дат и моментов (S1): без сдвига под любым TZ процесса (CI гоняет и America/New_York).
import { Pool } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  DATABASE_URL,
  createPool,
  seedOrg,
  truncateAll,
} from '../testing/test-db';

describe('даты и моменты (integration)', () => {
  let pool: Pool;
  let prisma: PrismaService;

  beforeAll(() => {
    pool = createPool();
    prisma = new PrismaService(DATABASE_URL);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('календарные даты хранятся без времени и не сдвигаются', async () => {
    // RULES §1-4: отпуска хранятся как календарные даты без времени
    const org = await seedOrg(pool);
    const v = await prisma.vacation.create({
      data: {
        employeeId: org.employee,
        backstopperId: org.other,
        startDate: new Date('2026-12-28T00:00:00Z'),
        endDate: new Date('2026-12-31T00:00:00Z'),
        workDays: 4,
        createdAt: new Date('2026-12-01T03:00:00Z'),
      },
    });
    const back = await prisma.vacation.findUniqueOrThrow({
      where: { id: v.id },
    });
    expect(back.startDate.toISOString()).toBe('2026-12-28T00:00:00.000Z');
    expect(back.endDate.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    const { rows } = await pool.query(
      `SELECT "startDate"::text AS s, "endDate"::text AS e FROM "Vacation" WHERE id = $1`,
      [v.id],
    );
    expect(rows[0]).toEqual({ s: '2026-12-28', e: '2026-12-31' });
  });

  it('момент хранится в UTC: 2026-12-31T18:00Z — это 1 января в Бишкеке', async () => {
    // RULES §1-4: моменты времени в UTC; «день» определяется по COMPANY_TZ
    const org = await seedOrg(pool);
    const v = await prisma.vacation.create({
      data: {
        employeeId: org.employee,
        backstopperId: org.other,
        startDate: new Date('2027-01-11T00:00:00Z'),
        endDate: new Date('2027-01-15T00:00:00Z'),
        workDays: 5,
        status: 'APPROVED',
        createdAt: new Date('2026-12-01T03:00:00Z'),
      },
    });
    const entry = await prisma.ledgerEntry.create({
      data: {
        kind: 'DEBIT',
        vacationId: v.id,
        halfDays: 10,
        occurredAt: new Date('2026-12-31T18:00:00Z'),
      },
    });
    const back = await prisma.ledgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
    });
    expect(back.occurredAt.toISOString()).toBe('2026-12-31T18:00:00.000Z');
    const { rows } = await pool.query<{ d: string }>(
      `SELECT ("occurredAt" AT TIME ZONE 'Asia/Bishkek')::date::text AS d FROM "LedgerEntry" WHERE id = $1`,
      [entry.id],
    );
    expect(rows[0].d).toBe('2027-01-01');
  });
});
