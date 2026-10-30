import { IsOptional, IsString } from 'class-validator';
import { MaxCommentLength } from '../../common/comment-length';

/** Тело решения (architecture §7, Decision): только необязательный комментарий (RULES §4-1). */
export class DecisionDto {
  @IsOptional()
  @IsString()
  @MaxCommentLength()
  comment?: string | null;
}
