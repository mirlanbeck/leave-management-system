import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  decideViaApi,
  email,
  loginAs,
  openFromNav,
  submitViaApi,
  transferViaApi,
  waitForSettledInbox,
} from './helpers';

// Перенос (S6-b). Данные — фикстуры через API после e2e:reset, часы 2026-10-21 09:00 по Бишкеку.
// Остаток James (выход 2022-03-15) на 21.10.2026 — 37,5; после одобрения отпуска A — 32,5.
// Отпуск A: пн 09.11 – пт 13.11.2026, 5 рабочих дней, backstopper Sophie Bennett.
// Перенос B: пн 16.11 – пт 20.11.2026.

async function approvedJamesVacation(request: APIRequestContext): Promise<number> {
  const id = await submitViaApi(request, 'james', {
    startDate: '2026-11-09',
    endDate: '2026-11-13',
    backstopper: 'Sophie Bennett',
  });
  await decideViaApi(request, 'daniel', id, 'approve');
  return id;
}

const today = (page: Page) => page.getByTestId('balance-today');
const myRows = (page: Page) => page.getByTestId('my-request-row');
const rowOf = (page: Page, period: string) => myRows(page).filter({ hasText: period });
const statusOf = (page: Page, period: string) => rowOf(page, period).getByTestId('my-request-status');
const OLD = '09.11.2026';
const NEW = '16.11.2026';

test.describe('Перенос', () => {
  // RULES §3-11, §5-2, §6-6, §8-2, §8-3: подача из отпуска, пометка, утверждение, календарь, письма
  test('перенос: подача, пометка, утверждение руководителем, новые даты в календаре', async ({
    page,
    browser,
    request,
  }) => {
    await approvedJamesVacation(request);
    await loginAs(page, 'james');
    await openFromNav(page, 'Отпуск');
    await expect(today(page)).toHaveText('32,5');

    // форма в строке: даты пустые, backstopper прежний (DECISIONS 2026-10-28 17:06)
    await rowOf(page, OLD).getByRole('button', { name: 'Перенести' }).click();
    const form = page.getByTestId('transfer-form');
    await expect(form.getByLabel('Начало')).toHaveValue('');
    await expect(form.getByLabel('Заменяющий (backstopper)').locator('option:checked')).toHaveText('Sophie Bennett');
    await expect(form).toContainText('Рабочих дней должно быть столько же: 5. Начало — не раньше сегодняшнего дня.');
    await form.getByLabel('Начало').fill('2026-11-16');
    await form.getByLabel('Окончание').fill('2026-11-20');
    await form.getByRole('button', { name: 'Отправить перенос' }).click();
    await expect(page.getByTestId('requests-outcome')).toHaveText(
      'Перенос подан: 16.11.2026–20.11.2026, статус «На согласовании». Старый отпуск действует до решения.',
    );

    // пока перенос ждёт решения: пометка, у старого нет «Отменить» и «Перенести» (RULES §5-2)
    await expect(statusOf(page, OLD)).toHaveText('Одобрена · перенос на рассмотрении');
    await expect(statusOf(page, NEW)).toHaveText('На согласовании');
    await expect(rowOf(page, OLD).getByRole('button')).toHaveCount(0);
    await expect(today(page)).toHaveText('32,5');

    // руководитель видит плашку переноса без остатка и подтверждает
    const daniel = await browser.newPage();
    await loginAs(daniel, 'daniel');
    await openFromNav(daniel, 'Согласование');
    const card = daniel.getByTestId('approval-card').filter({ hasText: 'James Walker' });
    await expect(card.getByTestId('approval-transfer')).toHaveText('Перенос одобренного отпуска');
    await expect(card.getByTestId('approval-available')).toHaveText('не проверяется (перенос)');
    await card.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(daniel.getByTestId('approvals-outcome')).toHaveText('Заявка James Walker одобрена');
    await daniel.close();

    // старый «Заменена переносом», новый «Одобрена», остаток не изменился (RULES §5-2, §6-6)
    await page.reload();
    await expect(statusOf(page, NEW)).toHaveText('Одобрена');
    await expect(statusOf(page, OLD)).toHaveText('Заменена переносом');
    await expect(today(page)).toHaveText('32,5');

    // календарь: новые даты, «Заменена переносом» не показывается (RULES §3-11, §7-2)
    await openFromNav(page, 'Календарь');
    await page.getByRole('button', { name: 'Следующий месяц →' }).click();
    await expect(page.getByTestId('calendar-month')).toHaveText('Ноябрь 2026');
    await expect(page.getByTestId('calendar-entry')).toHaveText(['James Walker, Фронт-отдел: 16.11.2026–20.11.2026']);

    // письма по переносу: одно о заявке руководителю, одно о решении сотруднику (RULES §8-2, §8-3)
    const messages = await waitForSettledInbox(request, 4);
    const transferMail = messages.filter((m) => m.Subject.includes('2026-11-16–2026-11-20'));
    expect(transferMail.map((m) => [m.To.map((t) => t.Address), m.Subject]).sort()).toEqual([
      [[email('daniel')], 'Новая заявка на отпуск: James Walker, 2026-11-16–2026-11-20'],
      [[email('james')], 'Заявка на отпуск одобрена: 2026-11-16–2026-11-20'],
    ]);
    expect(messages).toHaveLength(4); // плюс два письма по отпуску A из фикстуры
  });

  // RULES §3-11, §5-3: отмена переноса оставляет старый отпуск
  test('отмена переноса оставляет старый отпуск', async ({ page, request }) => {
    const a = await approvedJamesVacation(request);
    await transferViaApi(request, 'james', a, { startDate: '2026-11-16', endDate: '2026-11-20' });
    await loginAs(page, 'james');
    await openFromNav(page, 'Отпуск');
    await expect(statusOf(page, OLD)).toHaveText('Одобрена · перенос на рассмотрении');

    await rowOf(page, NEW).getByRole('button', { name: 'Отменить' }).click();
    await page.getByRole('button', { name: 'Да, отменить' }).click();
    await expect(page.getByTestId('requests-outcome')).toHaveText('Заявка отменена');

    await expect(statusOf(page, NEW)).toHaveText('Отменена · Старый отпуск остаётся');
    await expect(statusOf(page, OLD)).toHaveText('Одобрена');
    await expect(rowOf(page, OLD).getByRole('button', { name: 'Отменить' })).toBeVisible();
    await expect(rowOf(page, OLD).getByRole('button', { name: 'Перенести' })).toBeVisible();
    await expect(today(page)).toHaveText('32,5');
  });
});
