/** Остаток «сегодня» и «доступно на дату on» считает сервер (RULES §3-10). */
export function balancePath(on: string): string {
  return on === '' ? '/me/balance' : `/me/balance?on=${encodeURIComponent(on)}`;
}

/**
 * Дата панели по умолчанию равна началу заявки и идёт за ним, пока её не выбрали вручную
 * (RULES §3-10, DECISIONS 2026-10-26 00:43).
 */
export function nextOnDate(prevStart: string, newStart: string, currentOn: string): string {
  return currentOn === '' || currentOn === prevStart ? newStart : currentOn;
}

/** Каждый вызов начинает запрос; его функция отвечает, остался ли он последним. */
export function latestOnly(): () => () => boolean {
  let seq = 0;
  return () => {
    const mine = ++seq;
    return () => mine === seq;
  };
}
