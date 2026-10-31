import { Injectable, Logger } from '@nestjs/common';

/**
 * Доменные события (контракт architecture §9): ровно перечень RULES §10-2, включая смену
 * демо-часов (`clock.changed`, только в демо-режиме). Несут только идентификаторы, данные
 * клиент перечитывает сам.
 */
export type DomainEvent =
  | { type: 'vacation.approved'; employeeId: number; vacationId: number }
  | { type: 'vacation.cancelled'; employeeId: number; vacationId: number }
  | {
      type: 'vacation.transfer-approved';
      employeeId: number;
      vacationId: number;
      replacedId: number;
    }
  | { type: 'employee.hire-date-changed'; employeeId: number }
  | { type: 'clock.changed' };

export type EventListener = (event: DomainEvent) => void;

/**
 * Шина внутри процесса. `publish` вызывается после коммита (architecture §4): транзакция уже
 * зафиксирована, поэтому сбой подписчика пишется в лог и не меняет ответ API; потеря события
 * допустима (известное ограничение). Асинхронную обработку подписчик ловит сам (SseHub).
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger('EventBus');
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: DomainEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        this.logger.error(
          `подписчик ${event.type}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}
