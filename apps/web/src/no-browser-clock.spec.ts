import { describe, expect, it } from 'vitest';

// Исходники приложения (без тестов) читаются как текст.
const sources = import.meta.glob(['./**/*.{ts,tsx}', '!./**/*.spec.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('«сегодня» только с сервера', () => {
  // RULES §9-1
  it('в коде web нет чтения времени браузера: Date.now(), new Date() без аргументов, performance.now()', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    const offenders = Object.entries(sources)
      .filter(([, text]) => /Date\.now\(|new Date\(\s*\)|performance\.now\(/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
