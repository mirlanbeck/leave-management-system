import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiError,
  INTERNAL_ERROR_MESSAGE,
  MESSAGES,
  type Problem,
} from './problem';

/** Статус http-errors (body-parser): число в `status`/`statusCode` у не-HttpException. */
function foreignStatus(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const { status, statusCode } = e as {
    status?: unknown;
    statusCode?: unknown;
  };
  const n = typeof status === 'number' ? status : statusCode;
  return typeof n === 'number' && n >= 400 && n < 600 ? n : null;
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('Problem');

  catch(exception: unknown, host: ArgumentsHost): void {
    this.respond(exception, host.switchToHttp().getResponse<Response>());
  }

  respond(exception: unknown, res: Response): void {
    const { status, body } = this.toProblem(exception);
    res.status(status).json(body);
  }

  private toProblem(e: unknown): {
    status: number;
    body: Problem | { statusCode: number; message: string };
  } {
    if (e instanceof ApiError) {
      return { status: e.getStatus(), body: e.getResponse() as Problem };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      if (status === 404) return this.notFound();
      // Nest превращает битый JSON из body-parser в BadRequestException
      if (status === 400) return this.badRequest();
      return this.plain(status, e.message);
    }
    const status = foreignStatus(e);
    if (status === 400) return this.badRequest();
    if (status !== null && status < 500) {
      return this.plain(status, (e as Error).message);
    }
    // стек только в серверный лог, клиенту ничего из внутренностей (RULES §7-1)
    this.logger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return this.plain(500, INTERNAL_ERROR_MESSAGE);
  }

  private badRequest() {
    return {
      status: 400,
      body: {
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: MESSAGES.VALIDATION_FAILED,
      } satisfies Problem,
    };
  }

  private notFound() {
    return {
      status: 404,
      body: {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: MESSAGES.NOT_FOUND,
      } satisfies Problem,
    };
  }

  private plain(status: number, message: string) {
    return {
      status,
      body: {
        statusCode: status,
        message: status >= 500 ? INTERNAL_ERROR_MESSAGE : message,
      },
    };
  }
}
