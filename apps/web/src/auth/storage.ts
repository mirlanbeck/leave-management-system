export const TOKEN_KEY = 'leave.accessToken';

export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}

/** Токен только в sessionStorage (RULES §7-1); сбой хранилища не должен ломать страницу. */
export function createTokenStore(storage: () => Storage | undefined): TokenStore {
  return {
    get() {
      try {
        return storage()?.getItem(TOKEN_KEY) ?? null;
      } catch {
        return null;
      }
    },
    set(token) {
      try {
        storage()?.setItem(TOKEN_KEY, token);
      } catch {
        /* без хранилища сессия живёт только до перезагрузки */
      }
    },
    clear() {
      try {
        storage()?.removeItem(TOKEN_KEY);
      } catch {
        /* ничего */
      }
    },
  };
}

export const tokenStore = createTokenStore(() =>
  typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
);
