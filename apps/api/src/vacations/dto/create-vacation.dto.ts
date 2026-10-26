import { IsInt, IsOptional, IsString } from 'class-validator';

/**
 * Тело подачи заявки (architecture §7, VacationInput). Даты проверяет `parseApiDates`.
 * `backstopperId` обязателен по RULES §3-2, но в DTO необязателен: его отсутствие даёт
 * 422 BACKSTOPPER_REQUIRED, а не 400 (DECISIONS [S4]). `workDays` считает сервер.
 */
export class CreateVacationDto {
  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;

  @IsOptional()
  @IsInt()
  backstopperId?: number | null;

  @IsOptional()
  @IsString()
  comment?: string | null;
}
