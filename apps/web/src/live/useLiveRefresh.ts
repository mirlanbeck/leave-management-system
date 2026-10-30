import { createContext, useContext, useEffect } from 'react';
import type { LiveDispatcher } from './live-logic';

export const LiveContext = createContext<LiveDispatcher | null>(null);

/**
 * Перечитывание экрана в фоне на события RULES §10-2 и после повторного подключения потока.
 * Только «Календарь» и «Экран HR» (DECISIONS 2026-10-29 21:41). onChange должен быть стабильным.
 */
export function useLiveRefresh(onChange: () => void): void {
  const live = useContext(LiveContext);
  useEffect(() => {
    if (!live) return;
    const unsubscribe = live.subscribe(onChange);
    return () => {
      unsubscribe();
    };
  }, [live, onChange]);
}
