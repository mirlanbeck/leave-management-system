import { Module } from '@nestjs/common';
import { OrgModule } from '../org/org.module';
import { EventBus } from './event-bus';
import { DEFAULT_SSE_OPTIONS, SSE_OPTIONS, SseHub } from './sse-hub';
import { SseController } from './sse.controller';

/** Шина доменных событий и поток `GET /events` (architecture §9). */
@Module({
  imports: [OrgModule],
  controllers: [SseController],
  providers: [
    EventBus,
    SseHub,
    { provide: SSE_OPTIONS, useValue: DEFAULT_SSE_OPTIONS },
  ],
  exports: [EventBus],
})
export class EventsModule {}
