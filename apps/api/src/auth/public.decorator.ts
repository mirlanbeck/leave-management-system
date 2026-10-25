import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Маршрут без токена. Всё остальное закрыто глобальным guard (RULES §7-1). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
