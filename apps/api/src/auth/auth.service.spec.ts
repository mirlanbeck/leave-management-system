import { JwtService } from '@nestjs/jwt';
import { getRounds } from 'bcryptjs';
import { FakeClock } from '../clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { LOGIN_MAX_FAILURES, LoginAttempts } from './login-attempts';
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
    new LoginAttempts(new FakeClock('2026-10-24T03:00:00Z')),
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

describe('AuthService.login: лимит попыток', () => {
  const findUnique = jest.fn();
  const prisma = { user: { findUnique } } as unknown as PrismaService;
  let attempts: LoginAttempts;
  let service: AuthService;

  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue(null);
    verifyPassword.mockClear();
    attempts = new LoginAttempts(new FakeClock('2026-10-24T03:00:00Z'));
    service = new AuthService(
      prisma,
      new JwtService({ secret: 'unit-test-secret' }),
      new FakeClock('2026-10-24T03:00:00Z'),
      {},
      attempts,
    );
  });

  // RULES §7-1: при блокировке нет запроса в БД и bcrypt, путь одинаков для любого логина
  it.each(['существующий', 'нет-такого'])(
    'при блокировке (%s) пользователь не ищется и пароль не сравнивается',
    async (login) => {
      for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
        await attempts.begin(login);
      }
      findUnique.mockClear();
      verifyPassword.mockClear();
      await expect(service.login(login, 'pass')).rejects.toMatchObject({
        code: 'AUTH_TOO_MANY_ATTEMPTS',
      });
      expect(findUnique).not.toHaveBeenCalled();
      expect(verifyPassword).not.toHaveBeenCalled();
    },
  );

  // RULES §7-1, §6-7: верный пароль до даты выхода (403) сбрасывает счётчик
  it('403 AUTH_NOT_HIRED_YET сбрасывает счётчик', async () => {
    findUnique.mockResolvedValue({
      id: 1,
      passwordHash: await password.hashPassword('pass'),
      accessGranted: false,
      hireDate: new Date('2026-11-01T00:00:00Z'),
    });
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
      await expect(service.login('future', 'wrong')).rejects.toMatchObject({
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    }
    await expect(service.login('future', 'pass')).rejects.toMatchObject({
      code: 'AUTH_NOT_HIRED_YET',
    });
    expect(attempts.size).toBe(0);
  });
});
