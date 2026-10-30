import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { ApiError, MESSAGES } from '../common/problem';
import { APP_ENV, isDemoMode } from '../config/app-config';

/**
 * Без DEMO_MODE=true служебного эндпоинта нет: 404, как у неизвестного маршрута (RULES §9-2).
 * Middleware идёт раньше guard'ов, поэтому 404 и без токена (аудит 3, F-11).
 */
@Injectable()
export class DemoOnlyMiddleware implements NestMiddleware {
  constructor(@Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv) {}

  use(_req: unknown, _res: unknown, next: () => void): void {
    if (!isDemoMode(this.env)) {
      throw new ApiError(404, 'NOT_FOUND', MESSAGES.NOT_FOUND);
    }
    next();
  }
}
