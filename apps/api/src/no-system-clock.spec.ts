import fs from 'node:fs';
import path from 'node:path';

// Исходники api (без тестов и сгенерированного клиента Prisma) читаются как текст (аудит 3, F-12).
const sources = fs
  .readdirSync(__dirname, { recursive: true, encoding: 'utf8' })
  .map((f) => f.split(path.sep).join('/'))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  .filter((f) => !f.startsWith('generated/'))
  .map((f) => [f, fs.readFileSync(path.join(__dirname, f), 'utf8')] as const);

const count = (text: string, re: RegExp) =>
  (text.match(new RegExp(re, 'g')) ?? []).length;

/** Файл -> число совпадений, кроме разрешённых. */
const offenders = (re: RegExp, allowed: Record<string, number>) =>
  sources
    .map(([file, text]) => [file, count(text, re)] as const)
    .filter(([file, n]) => n !== (allowed[file] ?? 0))
    .map(([file, n]) => `${file}: ${n}`);

describe('время только через Clock', () => {
  // RULES §1-5, §9-1: системное время читает только SystemClock
  it('в коде api нет Date.now(), new Date() без аргументов, performance.now(), кроме SystemClock', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(
      offenders(/Date\.now\(|new Date\(\s*\)|performance\.now\(/, {
        'clock/clock.ts': 1,
      }),
    ).toEqual([]);
  });

  // RULES §1-5, §9-1: SystemClock в обход Clock - только там, где время системное по правилу
  it('new SystemClock() создают только ClockModule, DbClock, SseHub, AuthModule и seed', () => {
    expect(
      offenders(/new SystemClock\(/, {
        'auth/auth.module.ts': 1, // окно лимита входа, DECISIONS 2026-11-01 07:36
        'clock/clock.module.ts': 1, // без DEMO_MODE
        'clock/db-clock.ts': 1, // начальное значение часов, RULES §9-2
        'events/sse-hub.ts': 1, // закрытие потока по exp, DECISIONS 2026-10-30 00:57
        'seed.ts': 1, // без DEMO_MODE, как ClockModule
      }),
    ).toEqual([]);
  });
});
