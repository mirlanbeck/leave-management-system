import { Module } from '@nestjs/common';
import { EventBus } from './event-bus';

/** Шина доменных событий (architecture §9); SSE-эндпоинт добавится в S8. */
@Module({
  providers: [EventBus],
  exports: [EventBus],
})
export class EventsModule {}
