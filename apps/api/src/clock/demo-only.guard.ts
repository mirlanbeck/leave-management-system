import { CanActivate, Inject, Injectable } from '@nestjs/common';
import { ApiError, MESSAGES } from '../common/problem';
import { APP_ENV, isDemoMode } from '../config/app-config';

/** Без DEMO_MODE=true служебного эндпоинта нет: 404 (RULES §9-2). Идёт после проверки токена. */
@Injectable()
export class DemoOnlyGuard implements CanActivate {
  constructor(@Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv) {}

  canActivate(): boolean {
    if (!isDemoMode(this.env)) {
      throw new ApiError(404, 'NOT_FOUND', MESSAGES.NOT_FOUND);
    }
    return true;
  }
}
