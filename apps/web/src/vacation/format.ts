/** Дни с шагом 0,5 через запятую; минус типографский (RULES §2-7, §6-4). */
export function formatDays(days: number): string {
  const text = String(Math.abs(days)).replace('.', ',');
  return days < 0 ? `−${text}` : text;
}

/** Отрицательный остаток бывает только после сдвига даты выхода и помечается цветом (RULES §6-4). */
export function isNegativeDays(days: number): boolean {
  return days < 0;
}
