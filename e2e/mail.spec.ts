import { test, expect } from './fixtures';
import { email, submitViaApi, waitForSettledInbox } from './helpers';

// Доставка писем диспетчером outbox через настоящий Mailpit (S4-b, issue #38; DECISIONS [S4]:
// эта проверка живёт в e2e, integration-тесты диспетчера идут с подменным транспортом).
// Заявка подаётся через API (форма заявки - S4-c); e2e:reset ставит часы на 2026-10-21.
const NOV_2_6 = { startDate: '2026-11-02', endDate: '2026-11-06' };

test.describe('S4-b: письма через диспетчер outbox и Mailpit', () => {
  // RULES §8-2, §10-1: новая заявка - одно письмо руководителю
  test('заявка сотрудника: в Mailpit ровно одно письмо руководителю', async ({ request }) => {
    await submitViaApi(request, 'james', { ...NOV_2_6, backstopper: 'Sophie Bennett' });

    const messages = await waitForSettledInbox(request);

    expect(messages).toHaveLength(1);
    expect(messages[0].To.map((t) => t.Address)).toEqual([email('daniel')]);
    expect(messages[0].Subject).toBe('Новая заявка на отпуск: James Walker, 2026-11-02–2026-11-06');
  });

  // RULES §8-2: заявка директора - письмо HR («допуск HR»); §3-2: backstopper писем не получает
  test('заявка директора: одно письмо HR, backstopper писем не получает', async ({ request }) => {
    await submitViaApi(request, 'margaret', { ...NOV_2_6, backstopper: 'Thomas Reed' });

    const messages = await waitForSettledInbox(request);

    expect(messages).toHaveLength(1);
    expect(messages[0].To.map((t) => t.Address)).toEqual([email('emily')]);
    expect(messages[0].Subject).toBe('Допуск HR: новая заявка на отпуск, Margaret Collins, 2026-11-02–2026-11-06');
    expect(messages.flatMap((m) => m.To.map((t) => t.Address))).not.toContain(email('thomas'));
  });
});
