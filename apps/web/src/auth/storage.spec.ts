import { describe, expect, it } from 'vitest';
import { createTokenStore, TOKEN_KEY } from './storage';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('хранение токена', () => {
  // RULES §7-1
  it('токен сохраняется в переданном хранилище (sessionStorage) под одним ключом и очищается', () => {
    const storage = memoryStorage();
    const store = createTokenStore(() => storage);
    expect(store.get()).toBeNull();
    store.set('abc');
    expect(storage.getItem(TOKEN_KEY)).toBe('abc');
    expect(store.get()).toBe('abc');
    store.clear();
    expect(store.get()).toBeNull();
  });

  // RULES §7-1
  it('недоступное или падающее хранилище не ломает страницу', () => {
    const broken = new Proxy({} as Storage, {
      get() {
        throw new Error('SecurityError');
      },
    });
    const store = createTokenStore(() => broken);
    expect(() => store.set('abc')).not.toThrow();
    expect(store.get()).toBeNull();
    expect(() => store.clear()).not.toThrow();
    const none = createTokenStore(() => undefined);
    expect(none.get()).toBeNull();
  });
});
