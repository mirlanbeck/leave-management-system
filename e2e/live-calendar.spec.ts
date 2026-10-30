import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  cancelViaApi,
  changeHireDateViaApi,
  decideViaApi,
  loginAs,
  markNoReload,
  openFromNav,
  recallViaApi,
  submitViaApi,
  waitLive,
  wasReloaded,
} from './helpers';
import { setClock } from './reset.mjs';

// Обновление без перезагрузки (S8, RULES §7-4, §10-2): у каждого пользователя свой контекст
// браузера (токен в sessionStorage), изменения - из другого контекста или через API.
// Часы после e2e:reset 21.10.2026 09:00; отпуска в ноябре.
const entries = (page: Page) => page.getByTestId('calendar-team').getByTestId('calendar-entry');
const JAMES_NOV = 'James Walker, Фронт-отдел: 09.11.2026–13.11.2026';
const GRACE_NOV = 'Grace Morgan, Бэк-отдел: 16.11.2026–20.11.2026';

// контексты закрываются после теста: открытые потоки не переходят в следующий сценарий
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const context of opened.splice(0)) await context.close();
});

async function userPage(browser: Browser, login: string): Promise<Page> {
  const context = await browser.newContext();
  opened.push(context);
  const page = await context.newPage();
  await loginAs(page, login);
  return page;
}

/** Ноябрь в «Календаре», поток подключён, метка «без перезагрузки» поставлена. */
async function watchNovember(browser: Browser, login: string): Promise<Page> {
  const page = await userPage(browser, login);
  await page.goto('/calendar?month=2026-11');
  await expect(page.getByTestId('calendar-month')).toHaveText('Ноябрь 2026');
  await waitLive(page);
  await markNoReload(page);
  return page;
}

test.describe('живое обновление календаря и экрана HR', () => {
  // RULES §7-4, §7-2, §10-2: PDF «Календарь команды обновляется у всех, кто его смотрит, без обновления страницы»
  test('Календарь команды обновляется у всех, кто его смотрит, без обновления страницы', async ({
    browser,
    request,
  }) => {
    const daniel = await watchNovember(browser, 'daniel');
    const emily = await watchNovember(browser, 'emily');
    const olivia = await watchNovember(browser, 'olivia');
    for (const p of [daniel, emily, olivia]) {
      await expect(p.getByTestId('calendar-team').getByTestId('calendar-empty')).toBeVisible();
    }
    await expect(daniel.getByTestId('team-balance').filter({ hasText: 'James Walker' })).toContainText('37,5');

    // подача календарь не меняет; одобрение - у руководителя 1 и HR, руководителю 2 не видно
    const james = await submitViaApi(request, 'james', {
      startDate: '2026-11-09',
      endDate: '2026-11-13',
      backstopper: 'Sophie Bennett',
    });
    await decideViaApi(request, 'daniel', james, 'approve');
    await expect(entries(daniel)).toHaveText([JAMES_NOV]);
    await expect(entries(emily)).toHaveText([JAMES_NOV]);

    // следующее событие видно olivia: если бы отпуск james дошёл до неё, он пришёл бы раньше
    const grace = await submitViaApi(request, 'grace', {
      startDate: '2026-11-16',
      endDate: '2026-11-20',
      backstopper: 'Henry Price',
    });
    await decideViaApi(request, 'olivia', grace, 'approve');
    await expect(entries(olivia)).toHaveText([GRACE_NOV]);
    await expect(entries(emily)).toHaveText([JAMES_NOV, GRACE_NOV]);
    await expect(entries(daniel)).toHaveText([JAMES_NOV]);

    // остатки команды у руководителя тоже перечитаны: James 37,5 - 5
    await expect(daniel.getByTestId('team-balance').filter({ hasText: 'James Walker' })).toContainText('32,5');

    for (const p of [daniel, emily, olivia]) expect(await wasReloaded(p)).toBe(false);
  });

  // RULES §5-5, §6-3, §10-2 (аудит 2, F-2): отмена и отзыв убирают отпуск без перезагрузки;
  // экран HR перечитывается, открытая форма и разовое сообщение остаются
  test('отмена и отзыв из другого контекста; экран HR не сбрасывает форму и сообщение', async ({
    browser,
    request,
  }) => {
    const later = await submitViaApi(request, 'james', {
      startDate: '2026-11-23',
      endDate: '2026-11-27',
      backstopper: 'Sophie Bennett',
    });
    await decideViaApi(request, 'daniel', later, 'approve');
    const running = await submitViaApi(request, 'james', {
      startDate: '2026-11-09',
      endDate: '2026-11-13',
      backstopper: 'Sophie Bennett',
    });
    await decideViaApi(request, 'daniel', running, 'approve');
    const grace = await submitViaApi(request, 'grace', {
      startDate: '2026-11-09',
      endDate: '2026-11-13',
      backstopper: 'Henry Price',
    });
    await decideViaApi(request, 'olivia', grace, 'approve');
    // 11.11.2026: отпуска 09–13 ноября идут, отпуск 23–27 ещё не начался (без события clock.changed)
    await setClock('2026-11-11T03:00:00Z');

    const daniel = await watchNovember(browser, 'daniel');
    await expect(entries(daniel)).toHaveText([
      'James Walker, Фронт-отдел: 09.11.2026–13.11.2026',
      'James Walker, Фронт-отдел: 23.11.2026–27.11.2026',
    ]);

    // HR: разовое сообщение §6-3 после своей смены даты выхода и открытая форма отзыва у Grace
    const hr = await userPage(browser, 'emily');
    await openFromNav(hr, 'HR', 'Экран HR');
    await waitLive(hr);
    const liam = hr.getByTestId('hr-balance-row').filter({ hasText: 'Liam Foster' });
    await liam.getByRole('button', { name: 'Изменить дату выхода' }).click();
    await hr.getByLabel('Новая дата выхода').fill('2026-09-01');
    await hr.getByRole('button', { name: 'Сохранить' }).click();
    const outcome = hr.getByTestId('hr-balances-outcome');
    await expect(outcome).toHaveText('Дата изменена. Проверьте одобренные отпуска этого сотрудника');
    const graceRow = hr.getByTestId('hr-request-row').filter({ hasText: 'Grace Morgan' });
    await graceRow.getByRole('button', { name: 'Отзыв' }).click();
    await hr.getByLabel('Дата выхода').fill('2026-11-12');
    await markNoReload(hr);

    // сотрудник отменяет до начала: у руководителя исчезает
    await cancelViaApi(request, 'james', later);
    await expect(entries(daniel)).toHaveText([JAMES_NOV]);

    // отклонение календарь не меняет (события нет), отпуск james остаётся
    const sophie = await submitViaApi(request, 'sophie', {
      startDate: '2026-11-16',
      endDate: '2026-11-17',
      backstopper: 'Liam Foster',
    });
    await decideViaApi(request, 'daniel', sophie, 'reject');

    // HR отзывает из другого контекста: у руководителя исчезает, у HR строка «Отменена»
    const jamesRunning = hr
      .getByTestId('hr-request-row')
      .filter({ hasText: 'James Walker' })
      .filter({ hasText: '09.11.2026' });
    await expect(jamesRunning).toContainText('Одобрена');
    await recallViaApi(request, running, '2026-11-12');
    await expect(entries(daniel)).toHaveCount(0);
    await expect(daniel.getByTestId('calendar-team').getByTestId('calendar-empty')).toBeVisible();
    await expect(jamesRunning).toContainText('Отменена');

    // смена даты выхода из другого контекста: «Остатки» у HR и «Остатки команды» у руководителя
    const teamBalance = daniel.getByTestId('team-balance').filter({ hasText: 'James Walker' });
    const before = await teamBalance.innerText();
    await changeHireDateViaApi(request, 'James Walker', '2024-01-10');
    const jamesBalance = hr.getByTestId('hr-balance-row').filter({ hasText: 'James Walker' });
    await expect(jamesBalance.getByTestId('hr-balance-hire-date')).toHaveText('10.01.2024');
    await expect(teamBalance).not.toHaveText(before);

    // форма отзыва открыта с введённой датой, сообщение §6-3 на месте, перезагрузок не было
    await expect(hr.getByLabel('Дата выхода')).toHaveValue('2026-11-12');
    await expect(outcome).toHaveText('Дата изменена. Проверьте одобренные отпуска этого сотрудника');
    expect(await wasReloaded(hr)).toBe(false);
    expect(await wasReloaded(daniel)).toBe(false);
  });

  // RULES §10-2: событие при обрыве теряется, после переподключения данные перечитываются полностью
  test('после обрыва потока календарь перечитывается при переподключении', async ({ page, request }) => {
    test.setTimeout(60_000);
    let refused = 0;
    // соединение отклоняется целиком; route.continue не используется (может буферизовать поток)
    await page.route('**/api/events', (route) => {
      refused += 1;
      return route.abort('connectionreset');
    });
    await loginAs(page, 'daniel');
    await openFromNav(page, 'Календарь');
    await page.getByRole('button', { name: 'Следующий месяц →' }).click();
    await expect(page.getByTestId('calendar-month')).toHaveText('Ноябрь 2026');
    await expect.poll(() => refused).toBeGreaterThan(0);
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'connecting');
    await markNoReload(page);

    const james = await submitViaApi(request, 'james', {
      startDate: '2026-11-09',
      endDate: '2026-11-13',
      backstopper: 'Sophie Bennett',
    });
    await decideViaApi(request, 'daniel', james, 'approve');
    await expect(page.getByTestId('calendar-team').getByTestId('calendar-empty')).toBeVisible();

    await page.unroute('**/api/events');
    // пауза переподключения растёт до 30 с
    await waitLive(page, 35_000);
    await expect(entries(page)).toHaveText([JAMES_NOV]);
    expect(await wasReloaded(page)).toBe(false);
  });
});
