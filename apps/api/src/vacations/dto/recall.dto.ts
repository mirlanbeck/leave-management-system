import { IsString } from 'class-validator';

/** Тело отзыва (architecture §7): дата выхода обязательна (RULES §5-5); формат проверяет `parseApiDates`. */
export class RecallDto {
  @IsString()
  returnDate!: string;
}
