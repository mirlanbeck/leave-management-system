import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

// Доставка писем диспетчером outbox через настоящий Mailpit (S4-b, issue #38; DECISIONS [S4]:
// эта проверка живёт в e2e, integration-тесты диспетчера идут с подменным транспортом).
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
const PASSWORD = 'demo1234';
const email = (login: string) => `${login}@vacation.local`;

interface MailpitMessage {
  To: { Address: string }[];
  Subject: string;
}

async function token(request: APIRequestContext, login: string): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { login, password: PASSWORD } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** Подаёт заявку через API (форма заявки - S4-c); e2e:reset ставит часы на 2026-10-21. */
async function submit(request: APIRequestContext, login: string, backstopperName: string) {
  const auth = { Authorization: `Bearer ${await token(request, login)}` };
  const employees = (await (await request.get('/api/employees', { headers: auth })).json()) as {
    id: number;
    fullName: string;
  }[];
  const backstopper = employees.find((e) => e.fullName === backstopperName);
  expect(backstopper).toBeDefined();
  const res = await request.post('/api/vacations', {
    headers: auth,
    data: { startDate: '2026-11-02', endDate: '2026-11-06', backstopperId: backstopper!.id },
  });
  expect(res.status()).toBe(201);
}

async function inbox(request: APIRequestContext): Promise<MailpitMessage[]> {
  const res = await request.get(`${MAILPIT_URL}/api/v1/messages`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}

/** Ждёт первое письмо, затем ещё несколько проходов диспетчера: дубля быть не должно. */
async function settledInbox(request: APIRequestContext): Promise<MailpitMessage[]> {
  await expect.poll(async () => (await inbox(request)).length, { timeout: 20_000 }).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 5_000)); // больше двух интервалов опроса (OUTBOX_POLL_MS = 2000)
  return inbox(request);
}

test.describe('S4-b: письма через диспетчер outbox и Mailpit', () => {
  // RULES §8-2, §10-1: новая заявка - одно письмо руководителю
  test('заявка сотрудника: в Mailpit ровно одно письмо руководителю', async ({ request }) => {
    await submit(request, 'james', 'Sophie Bennett');

    const messages = await settledInbox(request);

    expect(messages).toHaveLength(1);
    expect(messages[0].To.map((t) => t.Address)).toEqual([email('daniel')]);
    expect(messages[0].Subject).toBe('Новая заявка на отпуск: James Walker, 2026-11-02–2026-11-06');
  });

  // RULES §8-2: заявка директора - письмо HR («допуск HR»); §3-2: backstopper писем не получает
  test('заявка директора: одно письмо HR, backstopper писем не получает', async ({ request }) => {
    await submit(request, 'margaret', 'Thomas Reed');

    const messages = await settledInbox(request);

    expect(messages).toHaveLength(1);
    expect(messages[0].To.map((t) => t.Address)).toEqual([email('emily')]);
    expect(messages[0].Subject).toBe('Допуск HR: новая заявка на отпуск, Margaret Collins, 2026-11-02–2026-11-06');
    expect(messages.flatMap((m) => m.To.map((t) => t.Address))).not.toContain(email('thomas'));
  });
});
