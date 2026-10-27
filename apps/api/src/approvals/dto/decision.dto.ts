import { IsOptional, IsString } from 'class-validator';

/** Тело решения (architecture §7, Decision): только необязательный комментарий (RULES §4-1). */
export class DecisionDto {
  @IsOptional()
  @IsString()
  comment?: string | null;
}
