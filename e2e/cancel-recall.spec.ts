import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { decideViaApi, loginAs, openFromNav, setDemoClock, submitViaApi, waitLive } from './helpers';

// Отмена и отзыв (S6-a). Данные — фикстуры через API после e2e:reset, часы 2026-10-21 09:00 по Бишкеку.
// Остаток James (выход 2022-03-15) на 21.10.2026 — 37,5; 1 ноября начисляется ещё 2,5.
// Отпуск James: пн 09.11 – пт 13.11.2026, 5 рабочих дней.

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
const hrRow = (page: Page) => page.getByTestId('hr-request-row').filter({ hasText: 'James Walker' }).first();

test.describe('Отмена и отзыв', () => {
  // RULES §5-4, §5-5, §5-6, §5-7: сценарий задания; после начала — отзыв HR с датой выхода
  test('Отмена согласованного отпуска возвращает дни в остаток. Отмена после начала возвращает только неиспользованные.', async ({
    page,
    browser,
    request,
  }) => {
    // До начала: сотрудник отменяет сам, дни возвращаются полностью
    await approvedJamesVacation(request);
    await loginAs(page, 'james');
    await openFromNav(page, 'Отпуск');
    await expect(today(page)).toHaveText('32,5');

    await myRows(page).first().getByRole('button', { name: 'Отменить' }).click();
    await expect(page.getByTestId('cancel-confirm')).toContainText(
      'Отменить отпуск 09.11.2026–13.11.2026? 5 раб. дн. вернутся в остаток.',
    );
    await page.getByRole('button', { name: 'Да, отменить' }).click();
    await expect(page.getByTestId('requests-outcome')).toHaveText('Отпуск отменён, дни возвращены в остаток');
    await expect(myRows(page).first()).toContainText('Отменена');
    await expect(today(page)).toHaveText('37,5');

    // После начала: сотрудник отменить не может, HR отзывает с датой выхода 12.11
    await approvedJamesVacation(request);
    await waitLive(page); // смена часов дойдёт до вкладки James только при открытом потоке
    const hr = await browser.newPage();
    await loginAs(hr, 'emily');
    await setDemoClock(hr, '2026-11-11');
    await openFromNav(hr, 'HR', 'Экран HR');

    // вкладка James перезагружается сама по смене часов в другой вкладке (RULES §10-2)
    await expect(page.getByTestId('clock-value')).toHaveText('11.11.2026 09:00');
    await expect(today(page)).toHaveText('35'); // 32,5 + начисление 1 ноября
    await expect(myRows(page).first()).toContainText('Одобрена');
    await expect(myRows(page).first().getByRole('button', { name: 'Отменить' })).toHaveCount(0);

    await hrRow(hr).getByRole('button', { name: 'Отзыв' }).click();
    await hr.getByLabel('Дата выхода').fill('2026-11-12');
    await hr.getByRole('button', { name: 'Подтвердить отзыв' }).click();
    await expect(hr.getByTestId('hr-requests-outcome')).toHaveText(
      'James Walker: отзыв оформлен, дата выхода 12.11.2026',
    );
    await expect(hrRow(hr)).toContainText('Отменена');

    // возвращаются только неиспользованные 12 и 13 ноября
    await page.reload();
    await expect(today(page)).toHaveText('37');
    await expect(myRows(page).first()).toContainText('Отменена');
    await hr.close();
  });

  // RULES §5-5, §5-10 (DECISIONS 2026-10-28 15:41): «Отзыв» только пока одобренный отпуск идёт
  test('кнопка «Отзыв» есть только над идущим одобренным отпуском', async ({ page, request }) => {
    await approvedJamesVacation(request);
    await loginAs(page, 'emily');
    await openFromNav(page, 'HR', 'Экран HR');
    await expect(hrRow(page)).toContainText('Одобрена');
    await expect(hrRow(page).getByRole('button', { name: 'Отзыв' })).toHaveCount(0);

    await setDemoClock(page, '2026-11-13');
    await page.reload();
    await expect(hrRow(page).getByRole('button', { name: 'Отзыв' })).toBeVisible();

    await setDemoClock(page, '2026-11-14');
    await page.reload();
    await expect(hrRow(page).getByRole('button', { name: 'Отзыв' })).toHaveCount(0);
  });
});
