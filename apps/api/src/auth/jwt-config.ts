/** Срок токена 8 часов (RULES §9-1); считает библиотека по системным часам, не по Clock. */
export const JWT_TTL_SECONDS = 8 * 60 * 60;

/** JWT_SECRET обязателен, значения по умолчанию нет: без него приложение не стартует (RULES §7-1). */
export function jwtSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('JWT_SECRET не задан: приложение не стартует без секрета');
  }
  return secret;
}
