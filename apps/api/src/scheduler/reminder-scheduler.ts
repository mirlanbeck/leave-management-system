import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../clock/clock';
import { companyLocalToInstant } from '../clock/company-time';
import { companyToday, companyTz } from '../clock/company-tz';
import { APP_ENV, reminderDays } from '../config/app-config';
import { fromDbDate, reminderDueOnPass, toDbDate } from '../domain';
import { VacationStatus } from '../generated/prisma/enums';
import { enqueueReminderMails, REMINDER_SELECT } from '../mail/reminder-mail';
import { PrismaService } from '../prisma/prisma.service';

/** Время планового напоминания по поясу компании (RULES §8-3). */
export const REMINDER_TIME = '09:00';

/**
 * Проход планировщика напоминаний (architecture §10). Идемпотентный, «сегодня» и 09:00 по
 * Clock и COMPANY_TZ (RULES §8-3, §9-4). Только ставит строки REMINDER в outbox; отправка,
 * повторы и проверка статуса «Одобрена» в момент отправки — за диспетчером (RULES §9-1).
 */
@Injectable()
export class ReminderScheduler {
  private readonly n: number;
  private readonly tz: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(APP_ENV) env: NodeJS.ProcessEnv,
  ) {
    this.n = reminderDays(env);
    this.tz = companyTz(env);
  }

  /**
   * Ставит напоминания по одобренным, ещё не начавшимся отпускам, для которых пора
   * (reminderDueOnPass): дата напоминания прошла или наступила и уже 09:00. Повторный проход,
   * перезапуск и откат часов дублей не дают: ключ «тип + отпуск + получатель» (RULES §10-1).
   * Возвращает число отпусков, по которым напоминание пора.
   */
  async pass(): Promise<number> {
    const now = await this.clock.now();
    const today = companyToday(now, this.tz);
    const nine = companyLocalToInstant(today, REMINDER_TIME, this.tz);
    const after9 = nine !== null && now.getTime() >= nine.getTime();
    const candidates = await this.prisma.vacation.findMany({
      where: {
        status: VacationStatus.APPROVED,
        startDate: { gt: toDbDate(today) },
      },
      select: REMINDER_SELECT,
      orderBy: { id: 'asc' },
    });
    const due = candidates.filter((v) =>
      reminderDueOnPass(fromDbDate(v.startDate), this.n, today, after9),
    );
    for (const v of due) await enqueueReminderMails(this.prisma, v, now);
    return due.length;
  }
}
