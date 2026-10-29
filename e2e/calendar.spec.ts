import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { decideViaApi, loginAs, openFromNav, submitViaApi } from './helpers';

// Календарь по роли без SSE (S5-e). Данные — фикстуры через API после e2e:reset (DECISIONS [S5]);
// часы 2026-10-21 09:00 по Бишкеку, календарь открывается на октябре, отпуска в ноябре.
// Два блока (RULES §7-2): «Мои отпуска» сверху, календарь команды снизу.
const mine = (page: Page) => page.getByTestId('calendar-mine');
const team = (page: Page) => page.getByTestId('calendar-team');
const entries = (block: Locator) => block.getByTestId('calendar-entry');
const month = (page: Page) => page.getByTestId('calendar-month');

/**
 * Ноябрь 2026: james (команда 1) и grace (команда 2) — «Одобрена»,
 * sophie (команда 1) — «На согласовании», chloe (команда 2) — «Отклонена».
 */
async function novemberFixtures(request: APIRequestContext) {
  const james = await submitViaApi(request, 'james', {
    startDate: '2026-11-09',
    endDate: '2026-11-13',
    backstopper: 'Sophie Bennett',
  });
  await decideViaApi(request, 'daniel', james, 'approve');
  const grace = await submitViaApi(request, 'grace', {
    startDate: '2026-11-16',
    endDate: '2026-11-20',
    backstopper: 'Henry Price',
  });
  await decideViaApi(request, 'olivia', grace, 'approve');
  await submitViaApi(request, 'sophie', {
    startDate: '2026-11-09',
    endDate: '2026-11-11',
    backstopper: 'James Walker',
  });
  const chloe = await submitViaApi(request, 'chloe', {
    startDate: '2026-11-23',
    endDate: '2026-11-27',
    backstopper: 'Grace Morgan',
  });
  await decideViaApi(request, 'olivia', chloe, 'reject');
}

/** Одобренный отпуск руководителя 1 (daniel) в ноябре: согласует заместитель (thomas). */
async function danielNovember(request: APIRequestContext) {
  const daniel = await submitViaApi(request, 'daniel', {
    startDate: '2026-11-23',
    endDate: '2026-11-27',
    backstopper: 'Olivia Turner',
  });
  await decideViaApi(request, 'thomas', daniel, 'approve');
}

async function openNovember(page: Page, login: string) {
  await loginAs(page, login);
  await openFromNav(page, 'Календарь');
  await expect(month(page)).toHaveText('Октябрь 2026');
  await page.getByRole('button', { name: 'Следующий месяц →' }).click();
  await expect(month(page)).toHaveText('Ноябрь 2026');
  await expect(page).toHaveURL(/\/calendar\?month=2026-11$/);
}

test.describe('Календарь по роли', () => {
  // RULES §7-2, §3-11
  test('сотрудник видит свои отпуска сверху, а внизу коллег и руководителя, но не другую команду', async ({
    page,
    request,
  }) => {
    await novemberFixtures(request);
    await danielNovember(request);

    await openNovember(page, 'james');

    await expect(mine(page).getByRole('heading', { name: 'Мои отпуска' })).toBeVisible();
    await expect(entries(mine(page))).toHaveText(['James Walker, Фронт-отдел: 09.11.2026–13.11.2026']);
    await expect(team(page).getByRole('heading', { name: 'Календарь команды' })).toBeVisible();
    // sophie «На согласовании» и grace из другой команды не видны; остатков у сотрудника нет
    await expect(entries(team(page))).toHaveText(['Daniel Brooks: 23.11.2026–27.11.2026']);
    await expect(page.getByTestId('team-balance')).toHaveCount(0);
  });

  // RULES §7-2: пустой блок показывается с текстом
  test('без своих одобренных отпусков верхний блок пустой, команда видна', async ({ page, request }) => {
    await novemberFixtures(request);

    await openNovember(page, 'sophie');

    await expect(mine(page).getByTestId('calendar-empty')).toHaveText('В этом месяце отпусков нет');
    await expect(entries(team(page))).toHaveText(['James Walker, Фронт-отдел: 09.11.2026–13.11.2026']);
  });

  // RULES §7-2, §7-3, §3-11
  test('руководитель видит свои отпуска сверху, команду и остатки подчинённых внизу', async ({ page, request }) => {
    await novemberFixtures(request);
    await danielNovember(request);

    await openNovember(page, 'daniel');

    await expect(entries(mine(page))).toHaveText(['Daniel Brooks: 23.11.2026–27.11.2026']);
    await expect(team(page).getByRole('heading', { name: 'Календарь команды' })).toBeVisible();
    // sophie «На согласовании» и grace из другой команды не видны
    await expect(entries(team(page))).toHaveText(['James Walker, Фронт-отдел: 09.11.2026–13.11.2026']);
    await expect(page.getByRole('heading', { name: 'Остатки команды на 21.10.2026' })).toBeVisible();
    await expect(page.getByTestId('team-balance').locator('td:first-child')).toHaveText([
      'James Walker',
      'Liam Foster',
      'Sophie Bennett',
    ]);
  });

  // RULES §7-2, §3-11
  test('HR видит календарь компании; месяц сохраняется при перезагрузке', async ({ page, request }) => {
    await novemberFixtures(request);

    await openNovember(page, 'emily');

    await expect(team(page).getByRole('heading', { name: 'Вся компания' })).toBeVisible();
    await expect(mine(page).getByTestId('calendar-empty')).toHaveText('В этом месяце отпусков нет');
    // chloe «Отклонена» и sophie «На согласовании» не видны
    await expect(entries(team(page))).toHaveText([
      'James Walker, Фронт-отдел: 09.11.2026–13.11.2026',
      'Grace Morgan, Бэк-отдел: 16.11.2026–20.11.2026',
    ]);
    await expect(page.getByTestId('team-balance')).toHaveCount(0);

    await page.reload();
    await expect(month(page)).toHaveText('Ноябрь 2026');
    await expect(entries(team(page))).toHaveCount(2);

    await page.getByRole('button', { name: '← Предыдущий месяц' }).click();
    await expect(month(page)).toHaveText('Октябрь 2026');
    await expect(mine(page).getByTestId('calendar-empty')).toHaveText('В этом месяце отпусков нет');
    await expect(team(page).getByTestId('calendar-empty')).toHaveText('В этом месяце отпусков нет');
  });
});
