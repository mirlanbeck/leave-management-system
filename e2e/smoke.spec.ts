import { test, expect } from './fixtures';

// ROADMAP S0: Playwright smoke «страница открывается»
test('страница открывается и видит API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Отпуска' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toContainText('доступен');
});
