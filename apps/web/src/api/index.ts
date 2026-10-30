import { createApiClient } from './client';
import { openEventStream, type StreamHandlers } from './events-stream';
import { tokenStore } from '../auth/storage';

let unauthorizedListener: (() => void) | null = null;

export function setUnauthorizedListener(listener: (() => void) | null): void {
  unauthorizedListener = listener;
}

export const api = createApiClient({
  fetchFn: (...args) => fetch(...args),
  getToken: () => tokenStore.get(),
  onUnauthorized: () => unauthorizedListener?.(),
});

/** Поток GET /events с тем же токеном и тем же обработчиком 401, что у api (RULES §7-1). */
export function openEvents(handlers: StreamHandlers): () => void {
  return openEventStream(
    {
      fetchFn: (...args) => fetch(...args),
      getToken: () => tokenStore.get(),
      onUnauthorized: () => unauthorizedListener?.(),
    },
    handlers,
  );
}
