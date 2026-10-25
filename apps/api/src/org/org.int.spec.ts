import { Pool } from 'pg';
import type { AuthUser } from '../auth/auth-user';
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

describe('OrgService на структуре RULES §7 (integration, нужен Postgres)', () => {
  let pool: Pool;
  let prisma: PrismaService;
  let org: OrgService;
  let users: PrismaAuthUsers;
  let ids: Record<RulesOrgKey, number>;

  const user = async (key: RulesOrgKey): Promise<AuthUser> =>
    (await users.findById(ids[key]))!;

  const seen = async (key: RulesOrgKey) => {
    const s = await org.visibleTo(await user(key));
    return s === 'ALL' ? s : [...s].sort((a, b) => a - b);
  };
  const idsOf = (...keys: RulesOrgKey[]) =>
    keys.map((k) => ids[k]).sort((a, b) => a - b);

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

  // RULES §7-2
  it('HR видит всех', async () => {
    expect(await seen('hr')).toBe('ALL');
  });

  // RULES §7-2, §7-3
  it('руководитель видит себя и прямых подчинённых', async () => {
    expect(await seen('manager1')).toEqual(
      idsOf('manager1', 'employee1', 'employee2', 'employee3'),
    );
    expect(await seen('manager2')).toEqual(
      idsOf('manager2', 'employee4', 'employee5', 'employee6'),
    );
  });

  // RULES §7-2
  it('сотрудник видит только себя', async () => {
    expect(await seen('employee1')).toEqual(idsOf('employee1'));
  });

  // RULES §7-3: вложенные не входят
  it('директор видит себя и заместителя', async () => {
    expect(await seen('director')).toEqual(idsOf('director', 'deputy'));
  });

  // RULES §7-3
  it('заместитель видит себя, HR, Р1, Р2, но не сотрудников Р1', async () => {
    expect(await seen('deputy')).toEqual(
      idsOf('deputy', 'hr', 'manager1', 'manager2'),
    );
    expect(await org.canSee(await user('deputy'), ids.employee1)).toBe(false);
  });

  // RULES §7-2
  it('canSee: руководитель Р1 видит С1, но не С4', async () => {
    const m1 = await user('manager1');
    expect(await org.canSee(m1, ids.employee1)).toBe(true);
    expect(await org.canSee(m1, ids.employee4)).toBe(false);
  });

  // RULES §7-2: структура читается на каждый запрос, без кэша
  it('перенос сотрудника в другую команду сразу меняет видимость', async () => {
    const m1 = await user('manager1');
    expect(await org.canSee(m1, ids.employee4)).toBe(false);
    await pool.query(`UPDATE "User" SET "managerId" = $1 WHERE id = $2`, [
      ids.manager1,
      ids.employee4,
    ]);
    expect(await org.canSee(m1, ids.employee4)).toBe(true);
  });
});
