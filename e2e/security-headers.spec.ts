import type { APIResponse, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { loginAs, openFromNav } from './helpers';

// Защитные заголовки (S9-f): пункта в RULES нет, метка по ROADMAP и DECISIONS (CLAUDE.md, правило 3).
// Заголовки ставит nginx на уровне server с always; api только не отдаёт X-Powered-By.
const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000';

/** CSP в виде «директива -> значения». */
function parseCsp(value: string | undefined): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of (value ?? '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values);
  }
  return directives;
}

function expectSecurityHeaders(res: APIResponse) {
  const headers = res.headers();
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  const csp = parseCsp(headers['content-security-policy']);
  expect(csp.get('default-src')).toEqual(["'self'"]);
  expect(csp.get('object-src')).toEqual(["'none'"]);
  expect(csp.get('base-uri')).toEqual(["'none'"]);
  expect(csp.get('form-action')).toEqual(["'self'"]);
  expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  // inline и eval не разрешены ни одной директивой
  expect(headers['content-security-policy']).not.toMatch(/unsafe-|data:|\*/);
  expect(headers['x-powered-by']).toBeUndefined();
  expect(headers['server'] ?? '').not.toContain('/');
}

/**
 * Собирает нарушения CSP со страницы: событие securitypolicyviolation и сообщения консоли.
 * Сбор на стороне теста, поэтому переживает перезагрузки (page.goto во входе).
 */
async function watchCsp(page: Page): Promise<string[]> {
  const hits: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) hits.push(`console: ${msg.text()}`);
  });
  await page.exposeFunction('__reportCsp', (text: string) => hits.push(`event: ${text}`));
  await page.addInitScript(() => {
    const w = window as unknown as { __reportCsp: (text: string) => void };
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__reportCsp(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return hits;
}

test.describe('Защитные заголовки', () => {
  // ROADMAP S9 (аудит 3, безопасность: заголовки); DECISIONS 2026-10-31 10:33; аудит 3, F-10
  test('страница / отдаёт CSP, X-Frame-Options, nosniff, Referrer-Policy; Server без версии', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    expectSecurityHeaders(res);
  });

  // ROADMAP S9 (аудит 3, безопасность: заголовки); DECISIONS 2026-10-31 10:33; аудит 3, F-10
  test('/api/health через nginx: те же заголовки, нет X-Powered-By', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expectSecurityHeaders(res);
  });

  // DECISIONS 2026-10-31 10:33: api напрямую (порт 3000) не отдаёт X-Powered-By; аудит 3, F-10
  test('api напрямую: нет X-Powered-By', async () => {
    const res = await fetch(`${API_URL}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

test.describe('CSP в браузере', () => {
  // DECISIONS 2026-10-31 10:33: контроль ловушки - inline-скрипт блокируется и даёт нарушение
  test('inline-скрипт не выполняется, нарушение видно', async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto('/login');
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true';
      document.head.appendChild(s);
    });
    await expect.poll(() => violations.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { __inlineRan?: boolean }).__inlineRan)).toBeUndefined();
  });

  // DECISIONS 2026-10-31 10:33: CSP не ломает основные страницы (вход, «Отпуск», календарь, экран HR)
  test('нет нарушений CSP на основных страницах', async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto('/login');
    await expect(page.getByTestId('api-status')).toContainText('доступен');
    await loginAs(page, 'james');
    await openFromNav(page, 'Отпуск');
    await openFromNav(page, 'Календарь');
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await loginAs(page, 'emily');
    await openFromNav(page, 'HR', 'Экран HR');
    expect(violations).toEqual([]);
  });
});
