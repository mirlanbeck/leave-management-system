import type { NestExpressApplication } from '@nestjs/platform-express';

// Общая настройка приложения для main.ts и тестов (createTestApp).
// Защитные заголовки ставит nginx; api только не раскрывает Express (DECISIONS 2026-10-31 10:33).
export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
}
