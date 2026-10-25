import { createApiClient } from './client';
import { tokenStore } from '../auth/storage';

let unauthorizedListener: (() => void) | null = null;

export function setUnauthorizedListener(listener: (() => void) | null): void {
  unauthorizedListener = listener;
}

export const api = createApiClient({
  fetchFn: (...args) => fetch(...args),
  getToken: () => tokenStore.get(),
  onUnauthorized: () => unauthorizedListener?.(),
});
