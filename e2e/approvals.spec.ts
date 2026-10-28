import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  decideViaApi,
  email,
  loginAs,
  openFromNav,
  signIn,
  submitViaApi,
  waitForSettledInbox,
} from './helpers';

// Экран «Согласование» (S5-d, issue #60). Данные — фикстуры через API после e2e:reset
// (DECISIONS [S5]); часы 2026-10-21 09:00 по Бишкеку, ожидаемые числа сверены с API.
const openApprovals = (page: Page) => openFromNav(page, 'Согласование');
const cards = (page: Page) => page.getByTestId('approval-card');
const cardOf = (page: Page, fullName: string) => cards(page).filter({ hasText: fullName });
const outcome = (page: Page) => page.getByTestId('approvals-outcome');

function countPosts(page: Page, action: 'approve' | 'reject') {
  const seen = { count: 0 };
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith(`/${action}`)) seen.count += 1;
  });
  return seen;
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test.describe('Руководитель получает уведомление о новой заявке, сотрудник — о решении. По одному.', () => {
  // RULES §8-2, §10-1, §4-1: подача через форму, решение двойным кликом
  test('Руководитель получает уведомление о новой заявке, сотрудник — о решении. По одному.', async ({
    page,
    request,
  }) => {
    await loginAs(page, 'james');
    await openFromNav(page, 'Отпуск');
    await page.getByLabel('Начало').fill('2026-11-02');
    await page.getByLabel('Окончание').fill('2026-11-06');
    await page.getByLabel('Заменяющий (backstopper)').selectOption({ label: 'Sophie Bennett' });
    await page.getByRole('button', { name: 'Подать' }).click();
    await expect(page.getByTestId('submit-done')).toBeVisible();

    const afterSubmit = await waitForSettledInbox(request);
    expect(afterSubmit).toHaveLength(1);
    expect(afterSubmit[0].To.map((t) => t.Address)).toEqual([email('daniel')]);

    await logout(page);
    await signIn(page, 'daniel');
    await openApprovals(page);
    const approves = countPosts(page, 'approve');

    await cardOf(page, 'James Walker').getByRole('button', { name: 'Подтвердить' }).dblclick();

    await expect(outcome(page)).toHaveText('Заявка James Walker одобрена');
    await expect(page.getByTestId('approvals-empty')).toBeVisible();
    expect(approves.count).toBe(1);

    const messages = await waitForSettledInbox(request, 2);
    expect(messages).toHaveLength(2);
    const decisions = messages.filter((m) => m.Subject.startsWith('Заявка на отпуск'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0].To.map((t) => t.Address)).toEqual([email('james')]);
    expect(decisions[0].Subject).toBe('Заявка на отпуск одобрена: 2026-11-02–2026-11-06');
  });
});

test.describe('Если в команде уже есть согласованный отпуск на пересекающиеся даты, руководитель видит это при согласовании.', () => {
  // RULES §4-6, §4-7: предупреждение по одобренному отпуску, согласование не блокируется
  test('Если в команде уже есть согласованный отпуск на пересекающиеся даты, руководитель видит это при согласовании.', async ({
    page,
    request,
  }) => {
    const james = await submitViaApi(request, 'james', {
      startDate: '2026-11-09',
      endDate: '2026-11-13',
      backstopper: 'Sophie Bennett',
    });
    await decideViaApi(request, 'daniel', james, 'approve');
    await submitViaApi(request, 'sophie', {
      startDate: '2026-11-11',
      endDate: '2026-11-17',
      backstopper: 'James Walker',
      comment: 'Семейная поездка',
    });

    await loginAs(page, 'daniel');
    await openApprovals(page);

    await expect(cards(page)).toHaveCount(1);
    const card = cardOf(page, 'Sophie Bennett');
    await expect(card.getByTestId('approval-period')).toHaveText('11.11.2026–17.11.2026');
    await expect(card.getByTestId('approval-workdays')).toHaveText('5');
    await expect(card.getByTestId('approval-backstopper')).toHaveText('James Walker');
    await expect(card.getByTestId('approval-comment')).toHaveText('Семейная поездка');
    await expect(card.getByTestId('approval-available')).toBeVisible();
    await expect(card.getByTestId('approval-overlaps')).toHaveText(
      'Пересекается с одобренными отпусками: James Walker 09.11.2026–13.11.2026',
    );
    await expect(card.getByTestId('approval-block-reason')).toHaveCount(0);

    await card.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(outcome(page)).toHaveText('Заявка Sophie Bennett одобрена');
  });
});

test.describe('S5-d: экран «Согласование»', () => {
  // RULES §10-1, §8-2: две вкладки решают одну заявку — одно решение, одно письмо о решении
  test('две вкладки решают одну заявку: вторая получает «уже обработана», письмо о решении одно', async ({
    page,
    request,
  }) => {
    await submitViaApi(request, 'james', {
      startDate: '2026-11-02',
      endDate: '2026-11-06',
      backstopper: 'Sophie Bennett',
    });

    const tabA = page;
    const tabB = await page.context().newPage(); // токен в sessionStorage: у вкладки свой вход
    for (const tab of [tabA, tabB]) {
      await loginAs(tab, 'daniel');
      await openApprovals(tab);
      await expect(cardOf(tab, 'James Walker')).toBeVisible();
    }

    await cardOf(tabA, 'James Walker').getByRole('button', { name: 'Подтвердить' }).click();
    await expect(outcome(tabA)).toHaveText('Заявка James Walker одобрена');

    await cardOf(tabB, 'James Walker').getByRole('button', { name: 'Подтвердить' }).click();
    await expect(outcome(tabB)).toHaveText('Заявка уже обработана (ALREADY_PROCESSED)');
    await expect(tabB.getByTestId('approvals-empty')).toBeVisible();

    const messages = await waitForSettledInbox(request, 2);
    expect(messages).toHaveLength(2);
    expect(messages.filter((m) => m.Subject.startsWith('Заявка на отпуск одобрена'))).toHaveLength(1);
  });

  // RULES §4-2, §7-2, §8-2: у HR «Мои заявки» и «Допуск HR»; своя заявка без кнопок
  test('допуск HR: заявка директора у HR, своя заявка HR только в «Мои заявки», письмо директору', async ({
    page,
    request,
  }) => {
    await submitViaApi(request, 'margaret', {
      startDate: '2026-11-02',
      endDate: '2026-11-06',
      backstopper: 'Thomas Reed',
    });
    await submitViaApi(request, 'emily', {
      startDate: '2026-11-16',
      endDate: '2026-11-20',
      backstopper: 'Daniel Brooks',
    });

    await loginAs(page, 'emily');
    await openApprovals(page);

    const mine = page.getByRole('region', { name: 'Мои заявки' });
    await expect(mine.getByTestId('my-request-row')).toHaveCount(1);
    await expect(mine.getByTestId('my-request-row')).toHaveText(/16\.11\.2026\s*20\.11\.2026\s*5\s*На согласовании/);
    await expect(mine.getByRole('button')).toHaveCount(0);

    const clearance = page.getByRole('region', { name: 'Допуск HR' });
    await expect(clearance.getByRole('heading', { name: 'Допуск HR', level: 2 })).toBeVisible();
    await expect(clearance.getByTestId('approval-card')).toHaveCount(1);
    const card = cardOf(page, 'Margaret Collins');
    await expect(card.getByTestId('approval-period')).toHaveText('02.11.2026–06.11.2026');

    await card.getByLabel('Комментарий к решению (необязательно)').fill('Хорошего отдыха');
    await card.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(outcome(page)).toHaveText('Заявка Margaret Collins одобрена');
    await expect(clearance.getByTestId('approvals-empty')).toBeVisible();

    // 2 письма о новых заявках (emily — по заявке директора, thomas — по заявке HR) и решение директору
    const messages = await waitForSettledInbox(request, 3);
    expect(messages).toHaveLength(3);
    const decisions = messages.filter((m) => m.Subject.includes('одобрена'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0].To.map((t) => t.Address)).toEqual([email('margaret')]);
    expect(decisions[0].Subject).toBe('Допуск HR: заявка на отпуск одобрена, 2026-11-02–2026-11-06');
  });

  // RULES §4-3, §4-7: при подаче хватало, после одобрения другой заявки — нет; отклонить можно
  test('нехватка дней при согласовании: причина, «Подтвердить» недоступна, отклонение работает', async ({
    page,
    request,
  }) => {
    // 37,5 сегодня; A: 35 дней (доступно на 02.11 — 40), B: 9 дней (доступно на 21.12 — 42,5)
    const a = await submitViaApi(request, 'james', {
      startDate: '2026-11-02',
      endDate: '2026-12-18',
      backstopper: 'Sophie Bennett',
    });
    await submitViaApi(request, 'james', {
      startDate: '2026-12-21',
      endDate: '2026-12-31',
      backstopper: 'Sophie Bennett',
    });
    await decideViaApi(request, 'daniel', a, 'approve'); // 42,5 − 35 = 7,5 на 21.12

    await loginAs(page, 'daniel');
    await openApprovals(page);

    const card = cardOf(page, 'James Walker');
    await expect(card.getByTestId('approval-workdays')).toHaveText('9');
    await expect(card.getByTestId('approval-available')).toHaveText('7,5');
    await expect(card.getByTestId('approval-block-reason')).toHaveText(
      'Согласовать нельзя: осталось 7,5 дней, в заявке 9',
    );
    await expect(card.getByRole('button', { name: 'Подтвердить' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Отклонить' })).toBeEnabled();

    await card.getByLabel('Комментарий к решению (необязательно)').fill('Не хватает дней');
    await card.getByRole('button', { name: 'Отклонить' }).click();
    await expect(outcome(page)).toHaveText('Заявка James Walker отклонена');
    await expect(page.getByTestId('approvals-empty')).toBeVisible();

    await logout(page);
    await signIn(page, 'james');
    await openFromNav(page, 'Отпуск');
    await expect(page.getByTestId('my-request-row').first()).toHaveText(/21\.12\.2026\s*31\.12\.2026\s*9\s*Отклонена/);
  });
});
