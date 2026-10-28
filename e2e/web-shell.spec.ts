import { createHmac } from 'node:crypto';
import { test, expect } from './fixtures';
import { loginAs, signIn } from './helpers';

const TOKEN_KEY = 'leave.accessToken';
// Демо-секрет из docker-compose (только для демо); токен подписывается им же, как в API.
const JWT_SECRET = process.env.JWT_SECRET ?? 'demo-only-not-for-production';

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Просроченный токен того же пользователя, подписанный демо-секретом. */
function expiredTokenOf(realToken: string): string {
  const { sub } = JSON.parse(Buffer.from(realToken.split('.')[1], 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, iat: now - 7200, exp: now - 3600 })}`;
  const sig = createHmac('sha256', JWT_SECRET).update(head).digest('base64url');
  return `${head}.${sig}`;
}

test.describe('S3-d: каркас, вход и защита страниц', () => {
  // RULES §7-1, §7-2
  test('вход под сотрудником, руководителем и HR показывает разделы своей роли', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Разделы' });

    await loginAs(page, 'james');
    await expect(nav.getByRole('link')).toHaveText(['Профиль', 'Отпуск']);

    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, 'daniel');
    await expect(nav.getByRole('link')).toHaveText(['Профиль', 'Отпуск', 'Согласование']);

    await page.getByRole('button', { name: 'Выйти' }).click();
    await signIn(page, 'emily');
    await expect(nav.getByRole('link')).toHaveText(['Профиль', 'Отпуск', 'Согласование', 'HR']);
  });

  // RULES §7-2, §7-6
  test('профиль на чтение: имя, дата выхода, команда, руководитель; у директора руководитель пуст', async ({
    page,
  }) => {
    await loginAs(page, 'james');
    await expect(page.getByTestId('profile-name')).toHaveText('James Walker');
    await expect(page.getByTestId('profile-hire-date')).toHaveText('15.03.2022');
    await expect(page.getByTestId('profile-team')).toHaveText('Фронт-отдел');
    await expect(page.getByTestId('profile-manager')).toHaveText('Daniel Brooks');

    await page.getByRole('button', { name: 'Выйти' }).click();
    await signIn(page, 'margaret');
    await expect(page.getByTestId('profile-manager')).toHaveText('—');
    await expect(page.getByTestId('profile-team')).toHaveText('—');
  });

  // RULES §7-2
  test('запретная страница по прямому адресу редиректит на главную, а не показывает заглушку', async ({
    page,
  }) => {
    await loginAs(page, 'james');
    await page.goto('/hr');
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/approvals');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Профиль' })).toBeVisible();

    await page.getByRole('button', { name: 'Выйти' }).click();
    await signIn(page, 'daniel');
    await expect(page.getByTestId('current-user')).toHaveText('Daniel Brooks');
    await page.goto('/hr');
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { name: 'Согласование', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Выйти' }).click();
    await signIn(page, 'emily');
    await expect(page.getByTestId('current-user')).toHaveText('Emily Carter');
    await page.goto('/hr');
    await expect(page.getByRole('heading', { name: 'Экран HR' })).toBeVisible();
  });

  // RULES §7-1
  test('без входа любая страница ведёт на экран входа', async ({ page }) => {
    await page.goto('/approvals');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Сессия истекла')).toHaveCount(0);
  });

  // RULES §7-1
  test('токен лежит в sessionStorage, localStorage пуст', async ({ page }) => {
    await loginAs(page, 'james');
    const stored = await page.evaluate((key) => ({
      session: sessionStorage.getItem(key),
      localCount: localStorage.length,
    }), TOKEN_KEY);
    expect(stored.session).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(stored.localCount).toBe(0);
  });

  // RULES §7-1
  test('неверный пароль: сообщение об ошибке входа, без «Сессия истекла»', async ({ page }) => {
    await page.goto('/login');
    await signIn(page, 'james', 'wrong-password');
    await expect(page.getByRole('alert')).toContainText('Неверный логин или пароль');
    await expect(page.getByRole('alert')).toContainText('AUTH_INVALID_CREDENTIALS');
    await expect(page.getByText('Сессия истекла')).toHaveCount(0);
  });

  // RULES §7-1
  test('истёкший токен: «Сессия истекла, войдите снова» и возврат на прежнюю страницу', async ({
    page,
  }) => {
    await loginAs(page, 'daniel');
    const real = await page.evaluate((key) => sessionStorage.getItem(key)!, TOKEN_KEY);
    await page.evaluate(
      ([key, token]) => sessionStorage.setItem(key, token),
      [TOKEN_KEY, expiredTokenOf(real)],
    );

    await page.goto('/approvals');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Сессия истекла, войдите снова')).toBeVisible();

    // неверный пароль на этом же экране: сообщение о сессии уступает ошибке входа
    await signIn(page, 'daniel', 'wrong-password');
    await expect(page.getByRole('alert')).toContainText('Неверный логин или пароль');
    await expect(page.getByText('Сессия истекла')).toHaveCount(0);

    await signIn(page, 'daniel');
    await expect(page).toHaveURL(/\/approvals$/);
    await expect(page.getByRole('heading', { name: 'Согласование', level: 1 })).toBeVisible();
  });
});
