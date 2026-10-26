import { Logger } from '@nestjs/common';
import type { OutboxDispatcher } from './outbox-dispatcher';
import { OutboxWorker } from './outbox-worker';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ждёт условие с запасом: фиксированные паузы нестабильны под нагрузкой (параллельные jest-воркеры). */
async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > timeoutMs) throw new Error('условие не наступило');
    await tick(5);
  }
}

function worker(runOnce: () => Promise<number>, pollMs = 10) {
  const dispatcher = { runOnce } as unknown as OutboxDispatcher;
  return new OutboxWorker(dispatcher, {
    pollMs,
    retryBaseMs: 1,
    retryMaxMs: 1,
    mailFrom: 'x@y',
    smtpHost: 'h',
    smtpPort: 1,
  });
}

describe('OutboxWorker: периодический опрос диспетчера', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => errorSpy.mockRestore());

  // RULES §9-1: отправка из очереди по системному таймеру, без Clock
  it('после старта вызывает проход повторно с интервалом OUTBOX_POLL_MS', async () => {
    const runOnce = jest.fn().mockResolvedValue(0);
    const w = worker(runOnce);
    w.onApplicationBootstrap();
    await waitFor(() => runOnce.mock.calls.length >= 2);
    await w.onModuleDestroy();
  });

  // RULES §10-1: проходы одного воркера не накладываются
  it('следующий проход начинается только после окончания предыдущего', async () => {
    let active = 0;
    let maxActive = 0;
    const runOnce = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(30);
      active -= 1;
      return 0;
    });
    const w = worker(runOnce, 1);
    w.onApplicationBootstrap();
    await waitFor(() => runOnce.mock.calls.length >= 3);
    await w.onModuleDestroy();
    expect(maxActive).toBe(1);
  });

  // RULES §10-1: остановка дожидается текущего прохода, новых проходов нет
  it('onModuleDestroy ждёт текущий проход и останавливает цикл', async () => {
    let finished = false;
    const runOnce = jest.fn(async () => {
      await tick(50);
      finished = true;
      return 0;
    });
    const w = worker(runOnce, 1);
    w.onApplicationBootstrap();
    await waitFor(() => runOnce.mock.calls.length >= 1); // проход идёт
    await w.onModuleDestroy();
    expect(finished).toBe(true);
    const calls = runOnce.mock.calls.length;
    await tick(50);
    expect(runOnce.mock.calls.length).toBe(calls);
  });

  // RULES §9-1: ошибка прохода (например, БД недоступна) не останавливает опрос
  it('ошибка прохода пишется в лог, опрос продолжается', async () => {
    const runOnce = jest
      .fn()
      .mockRejectedValueOnce(new Error('БД недоступна'))
      .mockResolvedValue(0);
    const w = worker(runOnce);
    w.onApplicationBootstrap();
    await waitFor(() => runOnce.mock.calls.length >= 2);
    await w.onModuleDestroy();
    expect(errorSpy).toHaveBeenCalled();
  });

  // RULES §9-1
  it('остановка без старта не падает', async () => {
    await expect(
      worker(jest.fn().mockResolvedValue(0)).onModuleDestroy(),
    ).resolves.toBeUndefined();
  });
});
