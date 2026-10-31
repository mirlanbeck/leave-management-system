import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app-setup';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  // node - PID 1 в контейнере: без обработчика SIGTERM игнорируется и Docker ждёт 10 с;
  // при остановке SseHub закрывает открытые потоки (onModuleDestroy)
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
