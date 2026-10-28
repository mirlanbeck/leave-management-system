import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseApiDates } from '../common/api-date';
import { CancelDto } from './dto/cancel.dto';
import { CreateVacationDto } from './dto/create-vacation.dto';
import { RecallDto } from './dto/recall.dto';
import { ListVacationsQuery } from './dto/list-vacations.query';
import { parseVacationId } from './vacation-id';
import type { VacationView } from './vacation.mapper';
import { VacationsService } from './vacations.service';

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

  /** Отмена владельцем до начала (RULES §5-4); ошибки и порядок - architecture §8. */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- тело нужно только для проверки «лишних полей нет»
    @Body() _body: CancelDto,
  ): Promise<VacationView> {
    return this.vacations.cancel(user, parseVacationId(id));
  }

  /** Отзыв HR из идущего отпуска с датой выхода (RULES §5-5, §5-11). */
  @Post(':id/recall')
  @HttpCode(200)
  recall(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: RecallDto,
  ): Promise<VacationView> {
    const { returnDate } = parseApiDates({ returnDate: body.returnDate });
    return this.vacations.recall(user, parseVacationId(id), returnDate);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<VacationView> {
    return this.vacations.get(user, parseVacationId(id));
  }
}
