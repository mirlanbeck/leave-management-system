import { createReloadOnce } from './live-logic';

/**
 * Полная перезагрузка вкладки не больше одного раза: после установки часов формой и по событию
 * clock.changed, которое приходит и в ту же вкладку (RULES §9-3, §10-2).
 */
export const reloadPageOnce = createReloadOnce(() => window.location.reload());
