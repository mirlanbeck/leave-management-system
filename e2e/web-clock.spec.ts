import { test, expect } from './fixtures';
import { loginAs } from './helpers';

test.describe('S3-d: полоса демо-часов', () => {
  // RULES §9-2, §9-3
  test('полоса видна вошедшим любой роли: значение в поясе компании и «остановлены»', async ({ page }) => {
    for (const login of ['james', 'daniel', 'emily']) {
      await loginAs(page, login);
      // e2e:reset ставит часы на 2026-10-21 09:00 по Бишкеку
      await expect(page.getByTestId('clock-value')).toHaveText('21.10.2026 09:00');
      await expect(page.getByTestId('clock-strip')).toContainText('Asia/Bishkek');
      await expect(page.getByTestId('clock-frozen')).toHaveText('остановлены');
      await page.getByRole('button', { name: 'Выйти' }).click();
      await expect(page).toHaveURL(/\/login$/);
    }
  });

  // RULES §9-3
  test('на экране входа полосы нет', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
    await expect(page.getByTestId('clock-strip')).toHaveCount(0);
  });

  // RULES §9-3
  test('форма открывается с датой текущих часов и временем 09:00', async ({ page }) => {
    await loginAs(page, 'james');
    await expect(page.getByLabel('Дата', { exact: true })).toHaveValue('2026-10-21');
    await expect(page.getByLabel('Время', { exact: true })).toHaveValue('09:00');
  });

  // RULES §9-3
  test('установка часов меняет значение и сохраняется после перезагрузки', async ({ page }) => {
    await loginAs(page, 'daniel');
    await page.getByLabel('Дата', { exact: true }).fill('2026-11-05');
    await page.getByRole('button', { name: 'Установить' }).click();
    await expect(page.getByTestId('clock-value')).toHaveText('05.11.2026 09:00');

    await page.getByLabel('Время', { exact: true }).fill('14:30');
    await page.getByRole('button', { name: 'Установить' }).click();
    await expect(page.getByTestId('clock-value')).toHaveText('05.11.2026 14:30');

    await page.reload();
    await expect(page.getByTestId('clock-value')).toHaveText('05.11.2026 14:30');
  });

  // RULES §9-3
  test('ошибка установки показывается с кодом и русским сообщением', async ({ page }) => {
    await loginAs(page, 'emily');
    await page.getByLabel('Дата', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Установить' }).click();
    await expect(page.getByRole('alert')).toContainText('VALIDATION_FAILED');
    await expect(page.getByTestId('clock-value')).toHaveText('21.10.2026 09:00');
  });
});
