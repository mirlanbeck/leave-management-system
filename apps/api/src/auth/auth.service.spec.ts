import { JwtService } from '@nestjs/jwt';
import { getRounds } from 'bcryptjs';
import { FakeClock } from '../clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import * as password from './password';

jest.mock('./password', () => {
  const actual = jest.requireActual<typeof password>('./password');
  return { ...actual, verifyPassword: jest.fn(actual.verifyPassword) };
});

const verifyPassword = jest.mocked(password.verifyPassword);

describe('AuthService.login: неизвестный логин', () => {
  // в БД никого нет: любой логин неизвестен
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
  const service = new AuthService(
    prisma,
    new JwtService({ secret: 'unit-test-secret' }),
    new FakeClock('2026-10-24T03:00:00Z'),
    {},
  );

  beforeEach(() => verifyPassword.mockClear());

  // RULES §7-1: по времени ответа не видно, существует ли логин
  it('пароль сравнивается с фиктивным хешем той же стоимости', async () => {
    await expect(service.login('нет-такого', 'pass')).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    const [given, hash] = verifyPassword.mock.calls[0];
    expect(given).toBe('pass');
    expect(getRounds(hash)).toBe(getRounds(await password.hashPassword('x')));
  });

  // RULES §7-1: фиктивный хеш считается один раз, не на каждый запрос
  it('два входа сравнивают с одним и тем же хешем', async () => {
    await expect(service.login('a', 'p')).rejects.toBeDefined();
    await expect(service.login('b', 'p')).rejects.toBeDefined();
    expect(verifyPassword).toHaveBeenCalledTimes(2);
    expect(verifyPassword.mock.calls[1][1]).toBe(
      verifyPassword.mock.calls[0][1],
    );
  });

  // RULES §7-1: фиктивный хеш не даёт вход ни с каким паролем
  it('совпадение с фиктивным хешем всё равно 401', async () => {
    verifyPassword.mockResolvedValueOnce(true);
    await expect(service.login('нет-такого', 'pass')).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    });
  });
});
