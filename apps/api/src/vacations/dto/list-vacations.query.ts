import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional } from 'class-validator';
import { VacationStatus } from '../../generated/prisma/enums';

export const VACATION_SCOPES = ['mine', 'team', 'all'] as const;
export type VacationScope = (typeof VACATION_SCOPES)[number];

const STATUSES = Object.values(VacationStatus);

/** Query списка заявок: `scope` и повторяемый `status` (architecture §7). */
export class ListVacationsQuery {
  @IsOptional()
  @IsIn(VACATION_SCOPES, { message: 'scope: mine, team или all' })
  scope?: VacationScope;

  @IsOptional()
  // ?status=A даёт строку, ?status=A&status=B массив
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? (value as unknown[]) : [value],
  )
  @IsArray()
  @IsIn(STATUSES, { each: true, message: `status: ${STATUSES.join(', ')}` })
  status?: VacationStatus[];
}
