/**
 * Единственный источник «сейчас» в приложении (RULES §9).
 * Асинхронный: в демо-режиме значение читается из БД при каждом вызове.
 */
export abstract class Clock {
  abstract now(): Promise<Date>;
}

export class SystemClock extends Clock {
  now(): Promise<Date> {
    return Promise.resolve(new Date());
  }
}

/** Подменяемые часы для тестов. */
export class FakeClock extends Clock {
  private current: Date;

  constructor(initial: Date | string) {
    super();
    this.current = new Date(initial);
  }

  now(): Promise<Date> {
    return Promise.resolve(new Date(this.current));
  }

  set(moment: Date | string): void {
    this.current = new Date(moment);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
