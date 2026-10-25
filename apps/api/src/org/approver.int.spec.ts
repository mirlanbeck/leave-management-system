import { Pool } from 'pg';
import { PrismaAuthUsers } from '../auth/prisma-auth-users';
import { PrismaService } from '../prisma/prisma.service';
import {
  DATABASE_URL,
  RulesOrgKey,
  createPool,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';
import { OrgService } from './org.service';

describe('OrgService.approverOf на структуре RULES §7 (integration, нужен Postgres)', () => {
  let pool: Pool;
  let prisma: PrismaService;
  let org: OrgService;
  let users: PrismaAuthUsers;
  let ids: Record<RulesOrgKey, number>;

  const approverOf = async (key: RulesOrgKey) =>
    (await org.approverOf((await users.findById(ids[key]))!)).id;

  beforeAll(() => {
    pool = createPool();
    prisma = new PrismaService(DATABASE_URL);
    org = new OrgService(prisma);
    users = new PrismaAuthUsers(prisma);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    ids = await seedRulesOrg(pool, 'hash');
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  // RULES §4-1
  it('сотрудник -> его руководитель; руководитель, HR и заместитель -> свой начальник', async () => {
    expect(await approverOf('employee1')).toBe(ids.manager1);
    expect(await approverOf('employee5')).toBe(ids.manager2);
    expect(await approverOf('manager1')).toBe(ids.deputy);
    expect(await approverOf('hr')).toBe(ids.deputy);
    expect(await approverOf('deputy')).toBe(ids.director);
  });

  // RULES §4-2
  it('директор -> HR («допуск HR»)', async () => {
    expect(await approverOf('director')).toBe(ids.hr);
  });

  // RULES §4-2: ровно один HR в системе, без него согласующего директора нет
  it('нет HR -> ошибка, а не молчаливый выбор', async () => {
    await pool.query(`UPDATE "User" SET "isHr" = false`);
    await expect(approverOf('director')).rejects.toThrow('HR');
  });
});
