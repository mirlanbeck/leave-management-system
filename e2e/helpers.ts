import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from './fixtures';

// Общие помощники e2e (DECISIONS 2026-10-27 10:03 [S5]): одна копия входа и ожидания писем на все спеки.
export const PASSWORD = 'demo1234';
export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

// Интервал опроса outbox, как в docker-compose (OUTBOX_POLL_MS = 2000 по умолчанию).
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 2000);

export interface MailpitMessage {
  To: { Address: string }[];
  Subject: string;
}

export async function signIn(page: Page, login: string, password = PASSWORD) {
  await page.getByLabel('Логин').fill(login);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
}

export async function loginAs(page: Page, login: string) {
  await page.goto('/login');
  await signIn(page, login);
  await expect(page.getByTestId('current-user')).toBeVisible();
}

/** Открывает страницу по ссылке навигации и ждёт её заголовок (по умолчанию он равен названию ссылки). */
export async function openFromNav(page: Page, linkName: string, heading = linkName) {
  await page.getByRole('link', { name: linkName }).click();
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

export async function readInbox(request: APIRequestContext): Promise<MailpitMessage[]> {
  const res = await request.get(`${MAILPIT_URL}/api/v1/messages`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}

/**
 * Ждёт первое письмо, затем паузу больше двух интервалов диспетчера и читает ящик:
 * дубля быть не должно (RULES §8-2, §10-1).
 */
export async function waitForSettledInbox(request: APIRequestContext): Promise<MailpitMessage[]> {
  await expect.poll(async () => (await readInbox(request)).length, { timeout: 20_000 }).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 2 * OUTBOX_POLL_MS + 1_000));
  return readInbox(request);
}
