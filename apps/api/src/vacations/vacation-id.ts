import { parsePathId } from '../common/path-id';

/** id заявки из пути; некорректный отвечает как несуществующий (architecture §7). */
export function parseVacationId(raw: string): number {
  return parsePathId(raw);
}
