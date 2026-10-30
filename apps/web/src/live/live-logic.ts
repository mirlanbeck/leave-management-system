import type { StreamHandlers } from '../api/events-stream';

/** События RULES §10-2, по которым «Календарь» и «Экран HR» перечитывают данные. */
export const LIVE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'vacation.approved',
  'vacation.cancelled',
  'vacation.transfer-approved',
  'employee.hire-date-changed',
]);

/** Смена демо-часов: вкладка перезагружается целиком (RULES §10-2; DECISIONS 2026-10-29 21:18). */
export const CLOCK_CHANGED = 'clock.changed';

/** Перезагрузка не больше одного раза за жизнь страницы: форма часов и событие делят её. */
export function createReloadOnce(reload: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    reload();
  };
}

export interface LiveDispatcher extends StreamHandlers {
  /** Подписка экрана на перечитывание; возвращает отписку. */
  subscribe(onChange: () => void): () => void;
}

/**
 * Обработчики потока для вкладки (architecture §9). Событие §10-2 и повторное подключение
 * ставят перечитывание; события одного чанка сливаются в одно (setTimeout 0). Первое
 * подключение с первой попытки данные не перечитывает: экран загрузил их сам.
 */
export function createLiveDispatcher(reloadPage: () => void): LiveDispatcher {
  const listeners = new Set<() => void>();
  const reload = createReloadOnce(reloadPage);
  let dropped = false;
  let pending = false;

  function markDirty() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      for (const listener of [...listeners]) listener();
    }, 0);
  }

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    onOpen() {
      if (dropped) markDirty();
    },
    onDrop() {
      dropped = true;
    },
    onEvent(type) {
      if (type === CLOCK_CHANGED) reload();
      else if (LIVE_EVENT_TYPES.has(type)) markDirty();
    },
  };
}
