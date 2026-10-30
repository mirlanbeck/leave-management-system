import { ValidateBy } from 'class-validator';

/** Комментарий заявки, переноса и решения (RULES §3-8, §4-1; DECISIONS 2026-10-30 14:24). */
export const COMMENT_MAX_LENGTH = 400;

/**
 * Длина в единицах UTF-16 (`string.length`), как у maxLength в браузере: эмодзи - 2.
 * Проверяется строка до обрезки пробелов (DECISIONS 2026-10-30 21:41). `@MaxLength` не подходит:
 * он считает суррогатную пару и селектор варианта за один символ. Не строку ловит `@IsString`.
 */
export function MaxCommentLength() {
  return ValidateBy({
    name: 'maxCommentLength',
    validator: {
      validate: (value: unknown) =>
        typeof value !== 'string' || value.length <= COMMENT_MAX_LENGTH,
      defaultMessage: (args) =>
        `${args?.property}: не длиннее ${COMMENT_MAX_LENGTH} символов`,
    },
  });
}
