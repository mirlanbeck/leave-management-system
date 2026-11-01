import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { SystemClock } from '../clock/clock';
import { APP_ENV } from '../config/app-config';
import { AuthUsers } from './auth-user';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JWT_TTL_SECONDS, jwtSecret } from './jwt-config';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LOGIN_LIMIT_CLOCK, LoginAttempts } from './login-attempts';
import { PrismaAuthUsers } from './prisma-auth-users';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_ENV],
      useFactory: (env: NodeJS.ProcessEnv) => ({
        secret: jwtSecret(env),
        signOptions: { algorithm: 'HS256', expiresIn: JWT_TTL_SECONDS },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginAttempts,
    // окно лимита входа по системным часам, не по демо-Clock (RULES §9-1, DECISIONS 2026-11-01 07:36)
    { provide: LOGIN_LIMIT_CLOCK, useValue: new SystemClock() },
    { provide: AuthUsers, useClass: PrismaAuthUsers },
    // все маршруты закрыты, открытые помечены @Public() (RULES §7-1)
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
