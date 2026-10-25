import { Matches } from 'class-validator';

export class SetClockDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date: формат YYYY-MM-DD' })
  date!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'time: формат HH:mm' })
  time!: string;
}
