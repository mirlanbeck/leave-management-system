import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ApiError, MESSAGES } from '../common/problem';
import { AuthUser, AuthUsers } from './auth-user';
import { IS_PUBLIC } from './public.decorator';

export type AuthedRequest = Request & { user: AuthUser };

function required(): ApiError {
  return new ApiError(401, 'AUTH_REQUIRED', MESSAGES.AUTH_REQUIRED);
}

/** Токен только из `Authorization: Bearer`, не из URL (RULES §7-1). */
function bearerToken(req: Request): string | null {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer (\S+)$/.exec(header);
  return m ? m[1] : null;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly users: AuthUsers,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req);
    if (!token) throw required();

    let sub: string | undefined;
    try {
      // срок и подпись по системным часам; алгоритм зафиксирован в настройках JwtModule
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token, {
        algorithms: ['HS256'],
      });
      sub = payload.sub;
    } catch (e) {
      if ((e as Error).name === 'TokenExpiredError') {
        throw new ApiError(
          401,
          'AUTH_TOKEN_EXPIRED',
          MESSAGES.AUTH_TOKEN_EXPIRED,
        );
      }
      throw required();
    }

    const id = Number(sub);
    if (!sub || !Number.isInteger(id) || id <= 0) throw required();
    const user = await this.users.findById(id);
    if (!user) throw required();
    req.user = user;
    return true;
  }
}
