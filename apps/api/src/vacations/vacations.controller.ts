import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseApiDates } from '../common/api-date';
import { ApiError, MESSAGES } from '../common/problem';
import { CreateVacationDto } from './dto/create-vacation.dto';
import { ListVacationsQuery } from './dto/list-vacations.query';
import type { VacationView } from './vacation.mapper';
import { VacationsService } from './vacations.service';

/** Положительное целое в пределах Int4; всё остальное считается несуществующей заявкой (404). */
const ID_RE = /^[1-9]\d{0,8}$/;

@Controller('vacations')
export class VacationsController {
  constructor(private readonly vacations: VacationsService) {}

  /** Подача заявки (RULES §3): 201 и заявка PENDING; ошибки - architecture §8. */
  @Post()
  submit(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateVacationDto,
  ): Promise<VacationView> {
    const dates = parseApiDates({
      startDate: body.startDate,
      endDate: body.endDate,
    });
    return this.vacations.submit(user, { ...body, ...dates });
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListVacationsQuery,
  ): Promise<VacationView[]> {
    return this.vacations.list(user, query.scope, query.status);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<VacationView> {
    if (!ID_RE.test(id)) {
      throw new ApiError(404, 'NOT_FOUND', MESSAGES.NOT_FOUND);
    }
    return this.vacations.get(user, Number(id));
  }
}
