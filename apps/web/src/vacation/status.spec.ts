import { describe, expect, it } from 'vitest';
import { STATUS_LABELS, statusLabel } from './status';

describe('статус заявки по-русски', () => {
  // RULES §3-11
  it('каждый статус сервера показывается названием из RULES', () => {
    expect(statusLabel('PENDING')).toBe('На согласовании');
    expect(statusLabel('APPROVED')).toBe('Одобрена');
    expect(statusLabel('REJECTED')).toBe('Отклонена');
    expect(statusLabel('CANCELLED')).toBe('Отменена');
    expect(statusLabel('REPLACED')).toBe('Заменена переносом');
  });

  // RULES §3-11: пять статусов, других нет
  it('словарь содержит ровно пять статусов', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(['APPROVED', 'CANCELLED', 'PENDING', 'REJECTED', 'REPLACED']);
  });

  // RULES §3-11
  it('неизвестный код показывается как есть', () => {
    expect(statusLabel('ARCHIVED')).toBe('ARCHIVED');
  });
});
