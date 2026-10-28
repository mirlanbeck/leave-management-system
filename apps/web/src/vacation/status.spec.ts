import { describe, expect, it } from 'vitest';
import { marksText, STATUS_LABELS, statusLabel, statusWithMarks } from './status';

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

const plain = { status: 'APPROVED', transferPending: false, oldVacationKept: false } as const;

describe('пометки переноса', () => {
  // RULES §3-11: пометки «перенос на рассмотрении» и «Старый отпуск остаётся»
  it('пометки: пусто, «перенос на рассмотрении», «Старый отпуск остаётся»', () => {
    expect(marksText(plain)).toBe('');
    expect(marksText({ ...plain, transferPending: true })).toBe('перенос на рассмотрении');
    expect(marksText({ ...plain, oldVacationKept: true })).toBe('Старый отпуск остаётся');
  });

  // RULES §3-11; DECISIONS 2026-10-28 17:06: статус и пометка в одной ячейке через «·»
  it('статус с пометкой через «·», без пометки - только статус', () => {
    expect(statusWithMarks(plain)).toBe('Одобрена');
    expect(statusWithMarks({ ...plain, transferPending: true })).toBe('Одобрена · перенос на рассмотрении');
    expect(statusWithMarks({ status: 'REJECTED', transferPending: false, oldVacationKept: true })).toBe(
      'Отклонена · Старый отпуск остаётся',
    );
    expect(statusWithMarks({ status: 'CANCELLED', transferPending: false, oldVacationKept: true })).toBe(
      'Отменена · Старый отпуск остаётся',
    );
  });
});
