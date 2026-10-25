import { HttpException } from '@nestjs/common';

/** Единый формат ошибки (architecture §8). */
export interface Problem {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Коды каталога, действующие с S3 (architecture §8). */
export type ProblemCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_REQUIRED'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_NOT_HIRED_YET'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED';

export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: ProblemCode | (string & {}),
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    const body: Problem = { statusCode: status, code, message };
    if (details) body.details = details;
    super(body, status);
  }
}

export const MESSAGES = {
  AUTH_INVALID_CREDENTIALS: 'Неверный логин или пароль',
  AUTH_REQUIRED: 'Требуется вход',
  AUTH_TOKEN_EXPIRED: 'Сессия истекла, войдите снова',
  AUTH_NOT_HIRED_YET: 'Доступ откроется в дату выхода на работу',
  NOT_FOUND: 'Не найдено',
  VALIDATION_FAILED: 'Некорректные данные запроса',
} as const;

export const INTERNAL_ERROR_MESSAGE = 'Внутренняя ошибка сервера';
