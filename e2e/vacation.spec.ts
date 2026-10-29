import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { loginAs, openFromNav, waitForSettledInbox } from './helpers';

// Страница «Отпуск»: остаток, подача заявки, «Мои заявки» (S4-c, issue #39).
// e2e:reset ставит часы на 2026-10-21 09:00 по Бишкеку; ожидаемые числа сверены с API.
const openVacation = (page: Page) => openFromNav(page, 'Отпуск');

async function fillRequest(page: Page, start: string, end: string, backstopper: string) {
  await page.getByLabel('Начало').fill(start);
  await page.getByLabel('Окончание').fill(end);
  await page.getByLabel('Заменяющий (backstopper)').selectOption({ label: backstopper });
}

const submitButton = (page: Page) => page.getByRole('button', { name: 'Подать' });
const rows = (page: Page) => page.getByTestId('my-request-row');

test.describe('S4-c: страница «Отпуск»', () => {
  // RULES §3-10, §2-5
  test('Сотрудник видит остаток дней на сегодня и сколько накопится к выбранной дате.', async ({ page }) => {
    await loginAs(page, 'james');
    await openVacation(page);

    await expect(page.getByTestId('balance-today-date')).toHaveText('21.10.2026');
    await expect(page.getByTestId('balance-today')).toHaveText('37,5');

    // дата панели подставляется из начала заявки (DECISIONS 2026-10-26 15:58)
    await page.getByLabel('Начало').fill('2026-12-01');
    await expect(page.getByLabel('Доступно на дату')).toHaveValue('2026-12-01');
    await expect(page.getByTestId('balance-on')).toHaveText('42,5');

    // 1 января начисление, затем обрезка до 15 (RULES §2-5)
    await page.getByLabel('Доступно на дату').fill('2027-01-01');
    await expect(page.getByTestId('balance-on')).toHaveText('15');
    await expect(page.getByTestId('balance-today')).toHaveText('37,5');
  });

  // RULES §9-1: «сегодня» берётся с сервера; §3-10: остаток только на странице «Отпуск»
  test('время браузера не влияет на «сегодня», на профиле остатка нет', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2030-05-05T10:00:00Z'));
    await loginAs(page, 'james');

    await expect(page.getByTestId('profile-name')).toHaveText('James Walker');
    await expect(page.getByTestId('balance-today')).toHaveCount(0);
    await expect(page.getByText('Доступно')).toHaveCount(0);

    await openVacation(page);
    await expect(page.getByTestId('balance-today-date')).toHaveText('21.10.2026');
    await expect(page.getByTestId('balance-today')).toHaveText('37,5');
  });

  // RULES §3-6, §3-11
  test('Liam до первого начисления не может подать заявку, после 1-го числа может', async ({ page }) => {
    await loginAs(page, 'liam');
    await openVacation(page);

    await expect(page.getByTestId('balance-today')).toHaveText('0');
    await page.getByLabel('Доступно на дату').fill('2026-11-02');
    await expect(page.getByTestId('balance-on')).toHaveText('1,5');

    await fillRequest(page, '2026-11-02', '2026-11-02', 'James Walker');
    await submitButton(page).click();
    await expect(page.getByTestId('submit-error')).toHaveText('У вас ещё нет накопленных дней (NO_ACCRUAL_YET)');
    await expect(page.getByTestId('my-requests-empty')).toBeVisible();

    // после «Установить» страница перезагружается (DECISIONS 2026-10-26 15:58)
    await page.getByLabel('Дата', { exact: true }).fill('2026-11-01');
    await page.getByRole('button', { name: 'Установить' }).click();
    await expect(page.getByTestId('clock-value')).toHaveText('01.11.2026 09:00');
    await expect(page.getByTestId('balance-today')).toHaveText('1,5');

    await fillRequest(page, '2026-11-02', '2026-11-02', 'James Walker');
    await submitButton(page).click();
    await expect(page.getByTestId('submit-done')).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveText(/02\.11\.2026\s*02\.11\.2026\s*1\s*На согласовании/);
  });

  // RULES §10-1, §8-2
  test('двойной клик по «Подать»: один запрос, одна заявка, одно письмо', async ({ page, request }) => {
    await loginAs(page, 'james');
    await openVacation(page);
    await expect(page.getByTestId('my-requests-empty')).toBeVisible();

    let posts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/vacations') posts += 1;
    });

    await fillRequest(page, '2026-11-02', '2026-11-06', 'Sophie Bennett');
    await submitButton(page).dblclick();

    await expect(page.getByTestId('submit-done')).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveText(/02\.11\.2026\s*06\.11\.2026\s*5\s*На согласовании/);
    await expect(page.getByTestId('submit-error')).toHaveCount(0);
    expect(posts).toBe(1);

    expect(await waitForSettledInbox(request)).toHaveLength(1);
  });
});

test.describe('Заявка на больше дней, чем будет накоплено к началу отпуска, не проходит. Заявка, нарушающая правила дробления, не проходит с понятным объяснением.', () => {
  // RULES §3-9, §3-10
  test('Заявка на больше дней, чем будет накоплено к началу отпуска, не проходит.', async ({ page }) => {
    await loginAs(page, 'james');
    await openVacation(page);

    await fillRequest(page, '2026-11-02', '2026-12-31', 'Sophie Bennett');
    await expect(page.getByTestId('balance-on')).toHaveText('40');
    await submitButton(page).click();

    await expect(page.getByTestId('submit-error')).toHaveText(
      'Не хватает дней: доступно 40, в заявке 44 (INSUFFICIENT_BALANCE)',
    );
    await expect(page.getByTestId('my-requests-empty')).toBeVisible();
  });

  // RULES §3-4: один год, минимум 1 рабочий день, без пересечений
  test('Заявка, нарушающая правила дробления, не проходит с понятным объяснением.', async ({ page }) => {
    await loginAs(page, 'james');
    await openVacation(page);
    const error = page.getByTestId('submit-error');

    await fillRequest(page, '2026-12-28', '2027-01-05', 'Sophie Bennett');
    await submitButton(page).click();
    await expect(error).toHaveText('Заявка не может охватывать два года, подайте две заявки (VACATION_CROSSES_YEAR)');

    // 24–25.10.2026: суббота и воскресенье
    await fillRequest(page, '2026-10-24', '2026-10-25', 'Sophie Bennett');
    await submitButton(page).click();
    await expect(error).toHaveText('В заявке нет ни одного рабочего дня (VACATION_NO_WORK_DAYS)');

    await fillRequest(page, '2026-11-02', '2026-11-06', 'Sophie Bennett');
    await submitButton(page).click();
    await expect(page.getByTestId('submit-done')).toBeVisible();
    await expect(rows(page)).toHaveCount(1);

    await fillRequest(page, '2026-11-04', '2026-11-10', 'Sophie Bennett');
    await submitButton(page).click();
    await expect(error).toHaveText('У вас уже есть заявка на эти даты: с 2026-11-02 по 2026-11-06 (VACATION_OVERLAP)');
    await expect(rows(page)).toHaveCount(1);
  });
});
