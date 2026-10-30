import { useEffect, useState, type ReactNode } from 'react';
import { openEvents } from '../api';
import { createLiveDispatcher } from './live-logic';
import { reloadPageOnce } from './reload-page';
import { LiveContext } from './useLiveRefresh';

/**
 * Одно соединение GET /events на вкладку вошедшего, на всех экранах (DECISIONS 2026-10-29 22:26).
 * clock.changed перезагружает вкладку, события §10-2 перечитывают подписанные экраны.
 * Состояние соединения в `data-live` - для e2e (ждать подключения перед действием).
 */
export function LiveEvents({ children }: { children: ReactNode }) {
  const [live] = useState(() => createLiveDispatcher(reloadPageOnce));
  const [status, setStatus] = useState<'connecting' | 'connected'>('connecting');

  useEffect(
    () =>
      openEvents({
        onEvent: (type, data) => live.onEvent(type, data),
        onOpen: () => {
          live.onOpen();
          setStatus('connected');
        },
        onDrop: () => {
          live.onDrop();
          setStatus('connecting');
        },
      }),
    [live],
  );

  return (
    <LiveContext.Provider value={live}>
      <span hidden data-testid="live-status" data-live={status} />
      {children}
    </LiveContext.Provider>
  );
}
