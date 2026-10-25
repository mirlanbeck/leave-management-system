/** Вернуться можно только на путь внутри приложения: иначе открытый редирект. */
export function safeReturnPath(from: unknown): string {
  if (typeof from !== 'string') return '/';
  if (!from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return '/';
  if (from === '/login' || from.startsWith('/login?')) return '/';
  return from;
}
