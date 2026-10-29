import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { SseHub } from './sse-hub';

/**
 * Поток событий RULES §10-2 (architecture §9). Токен только в `Authorization` проверяет
 * глобальный JwtAuthGuard (RULES §7-1): без него, с недействительным или истёкшим - 401,
 * поток не открывается. Кадр `event: <type>` + `data: <json>`, без `id`.
 */
@Controller('events')
export class SseController {
  constructor(private readonly hub: SseHub) {}

  @Get()
  async stream(@Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // nginx не буферизует ответ: кадр уходит клиенту сразу
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    await this.hub.connect(res, req.user.id, req.tokenExp);
  }
}
