import { ApiError, MESSAGES } from '../common/problem';

/** Положительное целое в пределах Int4; всё остальное считается несуществующей заявкой (404). */
const ID_RE = /^[1-9]\d{0,8}$/;

/** id заявки из пути; некорректный отвечает как несуществующий (architecture §7). */
export function parseVacationId(raw: string): number {
  if (!ID_RE.test(raw)) {
    throw new ApiError(404, 'NOT_FOUND', MESSAGES.NOT_FOUND);
  }
  return Number(raw);
}
