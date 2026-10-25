/* eslint-disable @typescript-eslint/unbound-method -- обработчики берутся с prototype для метаданных, this не нужен */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiError } from '../common/problem';
import { AuthUser, AuthUsers } from './auth-user';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Public } from './public.decorator';

const SECRET = 'unit-test-secret';
const user: AuthUser = {
  id: 7,
  login: 'u7',
  fullName: 'Сотрудник',
  hireDate: '2022-03-15',
  teamName: null,
  managerId: null,
  isHr: false,
  accessGranted: true,
};

class Stub extends AuthUsers {
  findById(id: number): Promise<AuthUser | null> {
    return Promise.resolve(id === user.id ? user : null);
  }
}

class Handlers {
  closed() {}
  @Public()
  open() {}
}

function ctx(
  req: Record<string, unknown>,
  handler: () => void = Handlers.prototype.closed,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => Handlers,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { algorithm: 'HS256', expiresIn: 28800 },
    verifyOptions: { algorithms: ['HS256'] },
  });
  const guard = new JwtAuthGuard(new Reflector(), jwt, new Stub());
  const bearer = (token: string) => ({
    headers: { authorization: `Bearer ${token}` },
    query: {},
  });
  const code = async (req: Record<string, unknown>) => {
    try {
      await guard.canActivate(ctx(req));
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      return (e as ApiError).code;
    }
    return 'OK';
  };

  // RULES §7-1
  it('действительный токен пропускает и кладёт пользователя в request', async () => {
    const req: Record<string, unknown> = bearer(jwt.sign({}, { subject: '7' }));
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(req.user).toEqual(user);
  });

  // RULES §7-1
  it('нет заголовка -> AUTH_REQUIRED', async () => {
    expect(await code({ headers: {}, query: {} })).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('не Bearer -> AUTH_REQUIRED', async () => {
    expect(
      await code({ headers: { authorization: 'Basic abc' }, query: {} }),
    ).toBe('AUTH_REQUIRED');
  });

  // RULES §9-1: срок токена по системным часам
  it('просроченный токен -> AUTH_TOKEN_EXPIRED', async () => {
    const token = jwt.sign({}, { subject: '7', expiresIn: -10 });
    expect(await code(bearer(token))).toBe('AUTH_TOKEN_EXPIRED');
  });

  // RULES §7-1
  it('алгоритм HS384 отвергается', async () => {
    const token = jwt.sign({}, { subject: '7', algorithm: 'HS384' });
    expect(await code(bearer(token))).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('alg:none отвергается', async () => {
    const enc = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: '7' })}.`;
    expect(await code(bearer(token))).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('чужой секрет отвергается', async () => {
    const other = new JwtService({ secret: 'другой секрет' });
    const token = other.sign({}, { subject: '7', expiresIn: 60 });
    expect(await code(bearer(token))).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('пользователь не найден -> AUTH_REQUIRED', async () => {
    const token = jwt.sign({}, { subject: '999' });
    expect(await code(bearer(token))).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('sub не число -> AUTH_REQUIRED', async () => {
    const token = jwt.sign({}, { subject: 'abc' });
    expect(await code(bearer(token))).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1: токен только из заголовка, не из URL
  it('токен в query игнорируется', async () => {
    const token = jwt.sign({}, { subject: '7' });
    expect(
      await code({ headers: {}, query: { access_token: token, token } }),
    ).toBe('AUTH_REQUIRED');
  });

  // RULES §7-1
  it('@Public пропускает без токена', async () => {
    await expect(
      guard.canActivate(
        ctx({ headers: {}, query: {} }, Handlers.prototype.open),
      ),
    ).resolves.toBe(true);
  });
});
