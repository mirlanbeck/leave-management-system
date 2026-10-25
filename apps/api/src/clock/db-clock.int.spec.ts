import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppConfigModule } from '../config/config.module';
import { APP_ENV } from '../config/app-config';
import { createPool, truncateAll } from '../testing/test-db';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { Clock, FakeClock, SystemClock } from './clock';
import { ClockModule } from './clock.module';
import { DbClock } from './db-clock';

// RULES §9-2: демо-часы в БД; нужен Postgres (DATABASE_URL)
describe('DbClock и выбор часов (integration)', () => {
  let pool: Pool;
  let prisma: PrismaService;

  beforeAll(() => {
    pool = createPool();
    prisma = new PrismaService(process.env.DATABASE_URL ?? '');
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
  beforeEach(() => truncateAll(pool));

  const rowCount = async (): Promise<number> => {
    const res = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM "ClockState"',
    );
    return Number(res.rows[0].n);
  };

  async function resolveClock(env: NodeJS.ProcessEnv): Promise<Clock> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, ClockModule],
    })
      .overrideProvider(APP_ENV)
      .useValue(env)
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    return moduleRef.get(Clock);
  }

  // RULES §9-2
  it('первое чтение создаёт строку с реальным моментом', async () => {
    const real = new FakeClock('2026-10-24T05:30:00Z');
    const clock = new DbClock(prisma, real);
    expect(await rowCount()).toBe(0);
    expect((await clock.now()).toISOString()).toBe('2026-10-24T05:30:00.000Z');
    expect(await rowCount()).toBe(1);
  });

  // RULES §9-2
  it('начальное значение пишется один раз и не перезаписывается при «перезапуске»', async () => {
    const first = new DbClock(prisma, new FakeClock('2026-10-24T05:30:00Z'));
    await first.now();
    const restarted = new DbClock(
      prisma,
      new FakeClock('2027-01-01T00:00:00Z'),
    );
    expect((await restarted.now()).toISOString()).toBe(
      '2026-10-24T05:30:00.000Z',
    );
    expect(await rowCount()).toBe(1);
  });

  // RULES §9-2
  it('параллельные первые вызовы дают одну строку и одно значение', async () => {
    const clocks = Array.from(
      { length: 6 },
      (_, i) =>
        new DbClock(prisma, new FakeClock(new Date(Date.UTC(2026, 9, 24, i)))),
    );
    const values = await Promise.all(clocks.map((c) => c.now()));
    expect(await rowCount()).toBe(1);
    expect(new Set(values.map((v) => v.toISOString())).size).toBe(1);
  });

  // RULES §9-2
  it('часы не идут: значение не меняется со временем', async () => {
    const clock = new DbClock(prisma, new FakeClock('2026-10-24T05:30:00Z'));
    const a = await clock.now();
    await new Promise((r) => setTimeout(r, 50));
    expect((await clock.now()).getTime()).toBe(a.getTime());
  });

  // RULES §9-2
  it('без кэша: изменение строки видно со следующего вызова, откат назад допустим', async () => {
    const clock = new DbClock(prisma, new FakeClock('2026-10-24T05:30:00Z'));
    await clock.now();
    await clock.set(new Date('2026-12-31T18:00:00Z'));
    expect((await clock.now()).toISOString()).toBe('2026-12-31T18:00:00.000Z');
    await pool.query(
      `UPDATE "ClockState" SET instant = '2026-10-21T03:00:00Z' WHERE id = 1`,
    );
    expect((await clock.now()).toISOString()).toBe('2026-10-21T03:00:00.000Z');
  });

  // RULES §9-2
  it('после сброса БД первый вызов пересоздаёт часы без перезапуска', async () => {
    const clock = new DbClock(prisma, new FakeClock('2026-10-24T05:30:00Z'));
    await clock.set(new Date('2026-11-01T03:00:00Z'));
    await truncateAll(pool);
    expect(await rowCount()).toBe(0);
    expect((await clock.now()).toISOString()).toBe('2026-10-24T05:30:00.000Z');
    expect(await rowCount()).toBe(1);
  });

  // RULES §9-2
  it('без DEMO_MODE=true часы системные, сохранённое значение игнорируется', async () => {
    await new DbClock(prisma).set(new Date('2001-01-01T00:00:00Z'));
    for (const flag of [undefined, '', 'false', 'True', '1', 'yes']) {
      const clock = await resolveClock({ DEMO_MODE: flag });
      expect(clock).toBeInstanceOf(SystemClock);
      const now = (await clock.now()).getTime();
      expect(Math.abs(now - Date.now())).toBeLessThan(5_000);
    }
    expect(await rowCount()).toBe(1);
  });

  // RULES §9-2
  it('с DEMO_MODE=true часы читаются из БД', async () => {
    await new DbClock(prisma).set(new Date('2026-10-21T03:00:00Z'));
    const clock = await resolveClock({ DEMO_MODE: 'true' });
    expect(clock).toBeInstanceOf(DbClock);
    expect((await clock.now()).toISOString()).toBe('2026-10-21T03:00:00.000Z');
  });
});
