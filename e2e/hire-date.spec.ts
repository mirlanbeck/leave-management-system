import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { decideViaApi, loginAs, openFromNav, readInbox, submitViaApi, waitForSettledInbox } from './helpers';

// Дата выхода (S6-c). Данные — фикстуры через API после e2e:reset, часы 2026-10-21 09:00 по Бишкеку.
// James (выход 2022-03-15): на 21.10.2026 — 37,5; после одобрения отпуска 09–13.11 (5 дней) — 32,5.
// Выход 2026-09-10: единственное начисление 1 октября, 21 день → 2,0; 2,0 − 5 = −3 (RULES §2-3).
// Выход 2026-11-02 (в будущем): начислений ещё нет, 0 − 5 = −5.
// Liam (выход 2026-10-12): до 1 ноября 0; выход 2026-09-01 → 1 октября 2,5 (30 дней, максимум).

const WARNING =
  'Внимание: проверьте дату выхода: от неё пересчитаются начисления и остаток. Одобренные отпуска и списания не изменятся, остаток может стать отрицательным';
const CHANGED = 'Дата изменена. Проверьте одобренные отпуска этого сотрудника';

const balanceRow = (page: Page, name: string) => page.getByTestId('hr-balance-row').filter({ hasText: name });

async function changeHireDate(page: Page, name: string, date: string) {
  await balanceRow(page, name).getByRole('button', { name: 'Изменить дату выхода' }).click();
  await page.getByLabel('Новая дата выхода').fill(date);
  await expect(page.getByTestId('hire-date-warning')).toHaveText(WARNING);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('hr-balances-outcome')).toHaveText(CHANGED);
}

test.describe('Дата выхода на работу', () => {
  // RULES §6-1…§6-5, §2-3, §8-1: сценарий задания
  test('Изменение даты выхода на работу пересчитывает накопление.', async ({ page, browser, request }) => {
    const id = await submitViaApi(request, 'james', {
      startDate: '2026-11-09',
      endDate: '2026-11-13',
      backstopper: 'Sophie Bennett',
    });
    await decideViaApi(request, 'daniel', id, 'approve');
    // письма о заявке и о решении доставлены; дальше их число не должно меняться (RULES §6-3, §8-1)
    const mailsBefore = (await waitForSettledInbox(request, 2)).length;

    await loginAs(page, 'emily');
    await openFromNav(page, 'HR', 'Экран HR');
    const james = balanceRow(page, 'James Walker');
    await expect(james.getByTestId('hr-balance-hire-date')).toHaveText('15.03.2022');
    await expect(james.getByTestId('hr-balance-days')).toHaveText('32,5');

    // позже: начисления пересчитаны, остаток отрицательный с минусом и цветом (RULES §6-1, §6-4)
    await changeHireDate(page, 'James Walker', '2026-09-10');
    await expect(james.getByTestId('hr-balance-hire-date')).toHaveText('10.09.2026');
    await expect(james.getByTestId('hr-balance-days')).toHaveText('−3');
    await expect(james.getByTestId('hr-balance-days')).toHaveClass(/negative/);

    // сообщение разовое: после перезагрузки его нет (RULES §6-3)
    await page.reload();
    await expect(page.getByTestId('hr-balances-outcome')).toHaveCount(0);
    await expect(james.getByTestId('hr-balance-days')).toHaveText('−3');

    // сотрудник видит минус; одобренный отпуск не отменён (RULES §6-3, §6-4)
    const employee = await browser.newPage();
    await loginAs(employee, 'james');
    await openFromNav(employee, 'Отпуск');
    await expect(employee.getByTestId('balance-today')).toHaveText('−3');
    await expect(employee.getByTestId('balance-today')).toHaveClass(/negative/);
    await expect(employee.getByTestId('my-request-row').first()).toContainText('Одобрена');

    // в будущее: доступ не отзывается, James входит снова (RULES §6-5, §6-7)
    await changeHireDate(page, 'James Walker', '2026-11-02');
    await expect(james.getByTestId('hr-balance-days')).toHaveText('−5');
    const again = await browser.newPage();
    await loginAs(again, 'james');
    await openFromNav(again, 'Отпуск');
    await expect(again.getByTestId('balance-today')).toHaveText('−5');

    // писем о смене даты нет (RULES §6-3, §8-1)
    await new Promise((r) => setTimeout(r, 5_000));
    expect((await readInbox(request)).length).toBe(mailsBefore);
    await employee.close();
    await again.close();
  });

  // RULES §6-1, §2-3: в любую сторону — сдвиг раньше даёт первое начисление
  test('сдвиг даты выхода раньше даёт начисление', async ({ page }) => {
    await loginAs(page, 'emily');
    await openFromNav(page, 'HR', 'Экран HR');
    const liam = balanceRow(page, 'Liam Foster');
    await expect(liam.getByTestId('hr-balance-days')).toHaveText('0');

    await changeHireDate(page, 'Liam Foster', '2026-09-01');
    await expect(liam.getByTestId('hr-balance-hire-date')).toHaveText('01.09.2026');
    await expect(liam.getByTestId('hr-balance-days')).toHaveText('2,5');
    await expect(liam.getByTestId('hr-balance-days')).not.toHaveClass(/negative/);
  });
});
