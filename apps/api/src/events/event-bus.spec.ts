import { Logger } from '@nestjs/common';
import { EventBus, type DomainEvent } from './event-bus';

const approved: DomainEvent = {
  type: 'vacation.approved',
  employeeId: 7,
  vacationId: 42,
};

describe('EventBus', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // RULES §10-2: событие доходит до каждого подписчика один раз
  it('передаёт событие всем подписчикам', () => {
    const bus = new EventBus();
    const a = jest.fn();
    const b = jest.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.publish(approved);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(approved);
    expect(b).toHaveBeenCalledWith(approved);
  });

  it('после отписки событие не приходит', () => {
    const bus = new EventBus();
    const a = jest.fn();
    const unsubscribe = bus.subscribe(a);
    unsubscribe();
    bus.publish(approved);
    expect(a).not.toHaveBeenCalled();
  });

  // architecture §4: публикация после коммита, сбой подписчика не меняет ответ API
  it('исключение подписчика пишется в лог и не мешает остальным', () => {
    const bus = new EventBus();
    const after = jest.fn();
    bus.subscribe(() => {
      throw new Error('подписчик упал');
    });
    bus.subscribe(after);
    expect(() => bus.publish(approved)).not.toThrow();
    expect(after).toHaveBeenCalledWith(approved);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
