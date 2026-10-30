import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { loginAs, markNoReload, openFromNav, setDemoClock, waitLive, wasReloaded } from './helpers';

// Смена демо-часов в одной вкладке перезагружает остальные (RULES §9-3, §10-2;
// DECISIONS 2026-10-29 21:18). Часы после e2e:reset 21.10.2026 09:00.

function countLoads(page: Page): () => number {
  let loads = 0;
  page.on('load', () => (loads += 1));
  return () => loads;
}

test.describe('демо-часы в двух вкладках', () => {
  // RULES §9-3, §10-2
  test('часы, поставленные в одной вкладке, видны в другой без ручной перезагрузки', async ({ browser }) => {
    const danielContext = await browser.newContext();
    const jamesContext = await browser.newContext();
    try {
      const daniel = await danielContext.newPage();
      await loginAs(daniel, 'daniel');
      const james = await jamesContext.newPage();
      await loginAs(james, 'james');
      await openFromNav(james, 'Отпуск');
      await expect(james.getByTestId('clock-value')).toHaveText('21.10.2026 09:00');
      await expect(james.getByTestId('balance-today')).toHaveText('37,5');
      await waitLive(james);
      await waitLive(daniel);
      await markNoReload(james);
      const jamesLoads = countLoads(james);
      const danielLoads = countLoads(daniel);

      await setDemoClock(daniel, '2026-11-02');

      // полоса и остаток с новым «сегодня»: начисление 1 ноября (RULES §2)
      await expect(james.getByTestId('clock-value')).toHaveText('02.11.2026 09:00');
      await expect(james.getByTestId('balance-today')).toHaveText('40');
      expect(await wasReloaded(james)).toBe(true);

      // каждая вкладка перезагрузилась ровно один раз, в том числе та, где ставили часы
      await waitLive(james);
      await waitLive(daniel);
      await new Promise((r) => setTimeout(r, 2_000));
      expect(jamesLoads()).toBe(1);
      expect(danielLoads()).toBe(1);
    } finally {
      await danielContext.close();
      await jamesContext.close();
    }
  });
});
