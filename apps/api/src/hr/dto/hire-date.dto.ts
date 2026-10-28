import { IsString } from 'class-validator';

/** Тело смены даты выхода (architecture §7): только `hireDate`; формат проверяет `parseApiDate`. */
export class HireDateDto {
  @IsString()
  hireDate!: string;
}
