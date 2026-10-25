/** Нормализованная ошибка API (architecture §8): код и русское сообщение показываются пользователю. */
export interface ApiProblem {
  status: number;
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(problem.message);
    this.name = 'ApiRequestError';
  }
}

export const NETWORK_PROBLEM: ApiProblem = {
  status: 0,
  code: 'NETWORK',
  message: 'Нет связи с сервером',
};

function fallbackMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504) return 'Сервер недоступен';
  if (status >= 500) return 'Внутренняя ошибка сервера';
  if (status === 404) return 'Не найдено';
  return `Ошибка запроса (${status})`;
}

/** Ответ без кода (500, 405 и т. п.) и не-JSON (страница nginx) тоже приводятся к ApiProblem. */
export function normalizeProblem(status: number, bodyText: string): ApiProblem {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = undefined;
  }
  if (typeof body === 'object' && body !== null) {
    const { code, message, details } = body as Record<string, unknown>;
    if (typeof message === 'string' && message !== '') {
      const problem: ApiProblem = { status, message };
      if (typeof code === 'string') problem.code = code;
      if (typeof details === 'object' && details !== null) {
        problem.details = details as Record<string, unknown>;
      }
      return problem;
    }
  }
  return { status, message: fallbackMessage(status) };
}

export function describeProblem(p: ApiProblem): string {
  return p.code ? `${p.message} (${p.code})` : p.message;
}

export function toProblem(e: unknown): ApiProblem {
  return e instanceof ApiRequestError ? e.problem : NETWORK_PROBLEM;
}
