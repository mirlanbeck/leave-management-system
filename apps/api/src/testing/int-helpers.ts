// Общие помощники integration-тестов API (нужен Postgres).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { hashPassword } from '../auth/password';
import { Db } from './test-db';

export const PASSWORD = 'pass-1234';

let cachedHash: Promise<string> | undefined;

/** Один хеш на весь прогон: bcrypt медленный. */
export function passwordHash(): Promise<string> {
  cachedHash ??= hashPassword(PASSWORD);
  return cachedHash;
}

export async function loginAs(
  app: INestApplication,
  login: string,
  password: string = PASSWORD,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ login, password });
  if (res.status !== 200) {
    throw new Error(`вход ${login} не удался: ${res.status} ${res.text}`);
  }
  return (res.body as { accessToken: string }).accessToken;
}

/** Выставляет демо-часы напрямую в БД. */
export async function setDbClock(db: Db, instant: string): Promise<void> {
  await db.query(
    `INSERT INTO "ClockState" (id, instant) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET instant = EXCLUDED.instant`,
    [instant],
  );
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
