import type { ApiClient } from '../api/client';
import type { ClockView, PublicConfig } from '../api/types';

/** Время в форме по умолчанию (RULES §9-3). */
export const DEFAULT_TIME = '09:00';

export type StripData = { kind: 'off' } | { kind: 'on'; companyTz: string; now: string };

/**
 * Полоса нужна только при demoMode из /config (RULES §9-2). Без флага /clock не запрашивается:
 * там служебного эндпоинта нет. Вызывается только для вошедшего (шапка с полосой рисуется после входа).
 */
export async function loadStrip(client: Pick<ApiClient, 'get'>): Promise<StripData> {
  const config = await client.get<PublicConfig>('/config');
  if (!config.demoMode) return { kind: 'off' };
  const clock = await client.get<ClockView>('/clock');
  return { kind: 'on', companyTz: config.companyTz, now: clock.now };
}

/** Дата и время передаются в поясе компании, момент UTC считает сервер (RULES §9-3). */
export function setClock(client: Pick<ApiClient, 'put'>, date: string, time: string): Promise<ClockView> {
  return client.put<ClockView>('/clock', { date, time });
}

/**
 * Установка часов и перезагрузка страницы: остаток, «сегодня» и списки на любой странице
 * запрашиваются заново по новым часам (RULES §9-3, §3-10; DECISIONS [S4]). При ошибке
 * перезагрузки нет, ошибка показывается в полосе.
 */
export async function applyClock(
  client: Pick<ApiClient, 'put'>,
  date: string,
  time: string,
  reload: () => void,
): Promise<void> {
  await setClock(client, date, time);
  reload();
}

type Parts = Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>;

/** Календарные части момента в поясе компании; время браузера не участвует, пояс задан явно. */
function partsIn(instant: string, timeZone: string): Parts {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of formatter.formatToParts(new Date(instant))) out[p.type] = p.value;
  return out as Parts;
}

/** YYYY-MM-DD в поясе компании: начальное значение поля даты. */
export function companyDate(instant: string, companyTz: string): string {
  const p = partsIn(instant, companyTz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** DD.MM.YYYY HH:mm в поясе компании: значение часов в полосе. */
export function formatCompanyMoment(instant: string, companyTz: string): string {
  const p = partsIn(instant, companyTz);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}
