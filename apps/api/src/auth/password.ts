import { randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';

const ROUNDS = 10;

/** bcrypt учитывает только первые 72 байта; длиннее при входе - 400 (RULES §7-1). */
export const PASSWORD_MAX_BYTES = 72;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ROUNDS);
}

export function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  return compare(password, passwordHash);
}

let dummyHash: Promise<string> | undefined;

/**
 * Хеш случайного пароля той же стоимости: с ним сравнивается пароль неизвестного логина,
 * чтобы время ответа не выдавало существование логина (RULES §7-1). Считается один раз.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHash;
}
