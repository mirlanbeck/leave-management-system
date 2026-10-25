import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './return-path';

describe('возврат на прежнюю страницу', () => {
  // RULES §7-1
  it('внутренний путь принимается как есть', () => {
    expect(safeReturnPath('/approvals')).toBe('/approvals');
    expect(safeReturnPath('/hr?tab=1')).toBe('/hr?tab=1');
  });

  // RULES §7-1
  it('внешние адреса, протокол-относительные и пустое значение дают главную', () => {
    expect(safeReturnPath('https://evil.example')).toBe('/');
    expect(safeReturnPath('//evil.example')).toBe('/');
    expect(safeReturnPath('/\\evil.example')).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
    expect(safeReturnPath(42)).toBe('/');
  });

  // RULES §7-1
  it('возврат на сам экран входа не делается', () => {
    expect(safeReturnPath('/login')).toBe('/');
    expect(safeReturnPath('/login?x=1')).toBe('/');
  });
});
