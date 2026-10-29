import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { decideViaApi, email, loginAs, readInbox, setDemoClock, submitViaApi, waitForSettledInbox } from './helpers';

// Напоминания (S7): планировщик после установки демо-часов и немедленное напоминание при позднем
// одобрении; доставка — диспетчер outbox через настоящий Mailpit. e2e:reset ставит часы на
// ср 2026-10-21 09:00 по Бишкеку; REMINDER_DAYS = 3.

const reminders = async (request: APIRequestContext) =>
  (await readInbox(request)).filter((m) => m.Subject.startsWith('Напоминание'));
const recipients = (messages: { To: { Address: string }[] }[]) =>
  messages.flatMap((m) => m.To.map((t) => t.Address)).sort();

test.describe('S7: напоминания', () => {
  // PDF; RULES §8-3, §9-4, §10-1
  test('За заданное число дней до начала отпуска сотрудник и руководитель получают напоминание. Одно.', async ({
    page,
    request,
  }) => {
    // пн 2026-11-02 – пт 2026-11-06: дата напоминания ср 2026-10-28 (3 рабочих дня до начала)
    const id = await submitViaApi(request, 'james', {
      startDate: '2026-11-02',
      endDate: '2026-11-06',
      backstopper: 'Sophie Bennett',
    });
    await decideViaApi(request, 'daniel', id, 'approve');
    await waitForSettledInbox(request, 2); // новая заявка и решение
    expect(await reminders(request)).toHaveLength(0);

    await loginAs(page, 'james');
    // RULES §8-3: в день напоминания до 09:00 — ещё рано
    await setDemoClock(page, '2026-10-28', '08:00');
    await waitForSettledInbox(request, 2);
    expect(await reminders(request)).toHaveLength(0);

    // RULES §8-3: в 09:00 — сотруднику и руководителю, по одному
    await setDemoClock(page, '2026-10-28', '09:00');
    await waitForSettledInbox(request, 4);
    const sent = await reminders(request);
    expect(recipients(sent)).toEqual([email('daniel'), email('james')].sort());
    expect(sent.map((m) => m.Subject).sort()).toEqual([
      'Напоминание: отпуск 2026-11-02–2026-11-06',
      'Напоминание: отпуск James Walker, 2026-11-02–2026-11-06',
    ]);

    // RULES §9-5, §10-1: перемотка вперёд, откат и снова вперёд — второго письма нет
    await setDemoClock(page, '2026-10-29', '09:00');
    await setDemoClock(page, '2026-10-27', '09:00');
    await setDemoClock(page, '2026-10-28', '09:00');
    await waitForSettledInbox(request, 4);
    expect(recipients(await reminders(request))).toEqual([email('daniel'), email('james')].sort());
  });

  // RULES §8-3: одобрено слишком поздно — напоминание сразу после согласования (аудит 2, F-1)
  test('одобрение, когда дата напоминания сегодня: напоминание сотруднику и руководителю сразу', async ({
    request,
  }) => {
    // пн 2026-10-26 – пт 2026-10-30: дата напоминания ср 2026-10-21 = сегодня
    const id = await submitViaApi(request, 'james', {
      startDate: '2026-10-26',
      endDate: '2026-10-30',
      backstopper: 'Sophie Bennett',
    });
    await decideViaApi(request, 'daniel', id, 'approve');
    await waitForSettledInbox(request, 4); // новая заявка, решение и два напоминания
    expect(recipients(await reminders(request))).toEqual([email('daniel'), email('james')].sort());
  });
});
