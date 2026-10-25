import { compare, hash } from 'bcryptjs';

const ROUNDS = 10;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ROUNDS);
}

export function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  return compare(password, passwordHash);
}
