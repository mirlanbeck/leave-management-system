import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, LoginResult } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LoginLockedError } from './login-attempts';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    try {
      return await this.auth.login(dto.login, dto.password);
    } catch (e) {
      // ProblemFilter заголовков не ставит; ответ он пишет в тот же res (RULES §7-1)
      if (e instanceof LoginLockedError) {
        res.setHeader('Retry-After', String(e.retryAfterSeconds));
      }
      throw e;
    }
  }
}
