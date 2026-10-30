import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Clock } from '../clock/clock';
import { companyToday, companyTz } from '../clock/company-tz';
import { ApiError, MESSAGES } from '../common/problem';
import { APP_ENV } from '../config/app-config';
import { fromDbDate } from '../domain/calendar-date';
import { PrismaService } from '../prisma/prisma.service';
import { dummyPasswordHash, verifyPassword } from './password';

export interface LoginResult {
  accessToken: string;
  expiresAt: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv,
  ) {}

  /** Фиктивный хеш считается при старте, чтобы и первый вход не выдавал себя по времени (RULES §7-1). */
  async onModuleInit(): Promise<void> {
    await dummyPasswordHash();
  }

  /** Сначала логин и пароль, потом дата выхода по Clock (RULES §7-1, §6-7). */
  async login(login: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { login } });
    // неизвестный логин и неверный пароль неразличимы и по ответу, и по времени:
    // bcrypt вызывается всегда, без пользователя вход не проходит (RULES §7-1)
    const ok = await verifyPassword(
      password,
      user?.passwordHash ?? (await dummyPasswordHash()),
    );
    if (!user || !ok) {
      throw new ApiError(
        401,
        'AUTH_INVALID_CREDENTIALS',
        MESSAGES.AUTH_INVALID_CREDENTIALS,
      );
    }

    if (!user.accessGranted) {
      const today = companyToday(await this.clock.now(), companyTz(this.env));
      if (fromDbDate(user.hireDate) > today) {
        throw new ApiError(
          403,
          'AUTH_NOT_HIRED_YET',
          MESSAGES.AUTH_NOT_HIRED_YET,
        );
      }
      // идемпотентно: два первых входа подряд безопасны (RULES §6-7)
      await this.prisma.user.updateMany({
        where: { id: user.id, accessGranted: false },
        data: { accessGranted: true },
      });
    }

    const accessToken = await this.jwt.signAsync(
      {},
      { subject: String(user.id) },
    );
    const { exp } = this.jwt.decode<{ exp: number }>(accessToken);
    return { accessToken, expiresAt: new Date(exp * 1000).toISOString() };
  }
}
