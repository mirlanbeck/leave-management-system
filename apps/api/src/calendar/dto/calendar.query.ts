import { IsString } from 'class-validator';

/**
 * Query календаря (architecture §7): `from` и `to` обязательны, другие параметры (например,
 * `employeeId`) дают 400 через белый список. Даты и порядок `from ≤ to` проверяет контроллер.
 */
export class CalendarQuery {
  @IsString()
  from!: string;

  @IsString()
  to!: string;
}
