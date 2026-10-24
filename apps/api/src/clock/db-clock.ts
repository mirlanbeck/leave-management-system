import type { PrismaClient } from '../generated/prisma/client';
import { Clock, SystemClock } from './clock';

type Db = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

/**
 * Демо-часы (RULES §9-2): момент хранится в единственной строке ClockState (id = 1),
 * читается при каждом вызове, без кэша. Строка создаётся при первом обращении
 * значением реального момента; параллельные первые вызовы дают одну строку.
 * Не зависит от Nest: используется и в seed.
 */
export class DbClock extends Clock {
  constructor(
    private readonly db: Db,
    private readonly real: Clock = new SystemClock(),
  ) {
    super();
  }

  async now(): Promise<Date> {
    const existing = await this.read();
    if (existing) return existing;
    const initial = await this.real.now();
    await this.db.$executeRaw`
      INSERT INTO "ClockState" (id, instant) VALUES (1, ${initial})
      ON CONFLICT (id) DO NOTHING`;
    const created = await this.read();
    if (!created) throw new Error('ClockState не создана');
    return created;
  }

  /** Устанавливает демо-часы (вперёд и назад). */
  async set(instant: Date): Promise<void> {
    await this.db.$executeRaw`
      INSERT INTO "ClockState" (id, instant) VALUES (1, ${instant})
      ON CONFLICT (id) DO UPDATE SET instant = EXCLUDED.instant, "updatedAt" = now()`;
  }

  private async read(): Promise<Date | null> {
    const rows = await this.db.$queryRaw<
      { instant: Date }[]
    >`SELECT instant FROM "ClockState" WHERE id = 1`;
    return rows[0]?.instant ?? null;
  }
}
