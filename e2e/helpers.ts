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
 * Ждёт, пока в ящике окажется не меньше minCount писем, затем паузу больше двух интервалов
 * диспетчера и читает ящик: дубля быть не должно (RULES §8-2, §10-1). minCount больше 1 нужен,
 * когда первое письмо уже лежит в ящике, а ждать надо следующее.
 */
export async function waitForSettledInbox(request: APIRequestContext, minCount = 1): Promise<MailpitMessage[]> {
  await expect
    .poll(async () => (await readInbox(request)).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(minCount);
  await new Promise((r) => setTimeout(r, 2 * OUTBOX_POLL_MS + 1_000));
  return readInbox(request);
}

// Фикстуры через HTTP API (DECISIONS [S5]): те же проверки, что у экрана, без seed:demo.
export const email = (login: string) => `${login}@vacation.local`;

export async function apiToken(request: APIRequestContext, login: string): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { login, password: PASSWORD } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function authHeaders(request: APIRequestContext, login: string) {
  return { Authorization: `Bearer ${await apiToken(request, login)}` };
}

export interface SubmitFixture {
  startDate: string;
  endDate: string;
  /** Полное имя заменяющего, как в справочнике. */
  backstopper: string;
  comment?: string;
}

/** Подаёт заявку от имени login и возвращает её id (POST /vacations, ожидается 201). */
export async function submitViaApi(request: APIRequestContext, login: string, v: SubmitFixture): Promise<number> {
  const headers = await authHeaders(request, login);
  const employees = (await (await request.get('/api/employees', { headers })).json()) as {
    id: number;
    fullName: string;
  }[];
  const backstopper = employees.find((e) => e.fullName === v.backstopper);
  expect(backstopper, `нет в справочнике: ${v.backstopper}`).toBeDefined();
  const res = await request.post('/api/vacations', {
    headers,
    data: { startDate: v.startDate, endDate: v.endDate, backstopperId: backstopper!.id, comment: v.comment },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

/** Решение от имени login (POST /vacations/{id}/approve|reject, ожидается 200). */
export async function decideViaApi(
  request: APIRequestContext,
  login: string,
  vacationId: number,
  kind: 'approve' | 'reject',
) {
  const res = await request.post(`/api/vacations/${vacationId}/${kind}`, {
    headers: await authHeaders(request, login),
    data: {},
  });
  expect(res.status()).toBe(200);
}

/**
 * Перенос одобренного отпуска от имени владельца (POST /vacations/{id}/transfer, ожидается 201):
 * backstopper прежний, как подставляет форма (RULES §5-2). Возвращает id заявки-переноса.
 */
export async function transferViaApi(
  request: APIRequestContext,
  login: string,
  vacationId: number,
  dates: { startDate: string; endDate: string },
): Promise<number> {
  const headers = await authHeaders(request, login);
  const source = (await (await request.get(`/api/vacations/${vacationId}`, { headers })).json()) as {
    backstopper: { id: number };
  };
  const res = await request.post(`/api/vacations/${vacationId}/transfer`, {
    headers,
    data: { ...dates, backstopperId: source.backstopper.id },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

/** Ставит демо-часы формой в шапке, как пользователь (RULES §9-3); время по умолчанию 09:00. */
export async function setDemoClock(page: Page, date: string, time = '09:00') {
  await page.getByLabel('Дата', { exact: true }).fill(date);
  await page.getByLabel('Время', { exact: true }).fill(time);
  await page.getByRole('button', { name: 'Установить' }).click();
  const [y, m, d] = date.split('-');
  await expect(page.getByTestId('clock-value')).toHaveText(`${d}.${m}.${y} ${time}`);
}
