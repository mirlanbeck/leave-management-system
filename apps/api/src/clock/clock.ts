/** Единственный источник «сейчас» в приложении (RULES §9). */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** Подменяемые часы для тестов и демо-режима. */
export class FakeClock extends Clock {
  private current: Date;

  constructor(initial: Date | string) {
    super();
    this.current = new Date(initial);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(moment: Date | string): void {
    this.current = new Date(moment);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
