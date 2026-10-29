import { Logger } from '@nestjs/common';
import type { ReminderScheduler } from './reminder-scheduler';
import { ReminderWorker, SCHEDULER_INTERVAL_MS } from './reminder-worker';

describe('ReminderWorker', () => {
  let pass: jest.Mock<Promise<number>, []>;
  let worker: ReminderWorker | undefined;

  const start = async (env: NodeJS.ProcessEnv) => {
    worker = new ReminderWorker({ pass } as unknown as ReminderScheduler, env);
    await worker.onApplicationBootstrap();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    pass = jest.fn(() => Promise.resolve(0));
  });

  afterEach(async () => {
    await worker?.onModuleDestroy();
    worker = undefined;
    jest.useRealTimers();
  });

  // RULES §9-4: проход при старте; DECISIONS 2026-10-22 9:35: в обычном режиме раз в минуту
  it('обычный режим: проход при старте и далее раз в минуту', async () => {
    await start({});
    expect(pass).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS - 1);
    expect(pass).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS * 3);
    expect(pass).toHaveBeenCalledTimes(5);
  });

  // RULES §9-4: в демо-режиме часы стоят; проход при старте и после установки часов
  it('демо-режим: только проход при старте, периодического нет', async () => {
    await start({ DEMO_MODE: 'true' });
    expect(pass).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS * 5);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  // RULES §9-4: проходы не накладываются — следующий отсчитывается от конца предыдущего
  it('долгий проход: следующий не начинается, пока не закончился текущий', async () => {
    await start({});
    let finish!: () => void;
    pass.mockImplementationOnce(
      () => new Promise<number>((resolve) => (finish = () => resolve(0))),
    );
    await jest.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS * 3);
    expect(pass).toHaveBeenCalledTimes(2);
    finish();
    await jest.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
    expect(pass).toHaveBeenCalledTimes(3);
  });

  // RULES §9-4: сбой прохода не останавливает планировщик
  it('сбой прохода записывается в лог, следующий проход выполняется', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    pass.mockRejectedValueOnce(new Error('БД недоступна'));
    await start({});
    expect(pass).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'Проход планировщика не выполнен: БД недоступна',
    );
    log.mockRestore();
    await jest.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
    expect(pass).toHaveBeenCalledTimes(2);
  });

  // RULES §9-4: после остановки проходов нет
  it('после остановки таймер не срабатывает', async () => {
    await start({});
    await worker!.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS * 3);
    expect(pass).toHaveBeenCalledTimes(1);
  });
});
