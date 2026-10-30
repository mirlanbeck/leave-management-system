import { Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { Clock } from '../clock/clock';
import { companyToday, companyTz } from '../clock/company-tz';
import { APP_ENV } from '../config/app-config';
import {
  availableOn,
  balanceToday,
  type BalanceInput,
  type CalendarDate,
  type LedgerAction,
} from '../domain';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type LedgerDb = Pick<Prisma.TransactionClient, 'ledgerEntry'>;

export interface BalanceView {
  employeeId: number;
  today: CalendarDate;
  /** Дни кратно 0,5; может быть отрицательным (RULES §6-4). */
  balance: number;
  on: CalendarDate | null;
  availableOn: number | null;
}

/**
 * Единственное место, где читается журнал и вызывается домен для остатка (RULES §3-10).
 * Ответ `/me/balance` и проверка остатка при подаче заявки идут через него, поэтому прогноз
 * и проверка не могут разойтись.
 */
@Injectable()
export class BalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv,
  ) {}

  /** «Сегодня» по Clock и COMPANY_TZ (RULES §1-3, §9-1). */
  async today(): Promise<CalendarDate> {
    return companyToday(await this.clock.now(), companyTz(this.env));
  }

  /**
   * Все списания и возвраты сотрудника, независимо от даты (RULES §6-6). `db` - клиент
   * транзакции, если чтение идёт под блокировкой сотрудника (architecture §6).
   */
  async ledgerOf(
    employeeId: number,
    db: LedgerDb = this.prisma,
  ): Promise<LedgerAction[]> {
    const rows = await db.ledgerEntry.findMany({
      where: { vacation: { employeeId } },
      select: { kind: true, halfDays: true, occurredAt: true },
    });
    return rows;
  }

  async input(
    employee: Pick<AuthUser, 'id' | 'hireDate'>,
    today: CalendarDate,
    db: LedgerDb = this.prisma,
  ): Promise<BalanceInput> {
    return {
      hireDate: employee.hireDate,
      ledger: await this.ledgerOf(employee.id, db),
      today,
      tz: companyTz(this.env),
    };
  }

  /**
   * «Доступно на дату `on`» в днях (RULES §3-10): тот же расчёт, что у `/me/balance` и подачи.
   * Экран согласования и повторная проверка при согласовании (RULES §4-3) идут через него.
   */
  async availableOnDays(
    employee: Pick<AuthUser, 'id' | 'hireDate'>,
    today: CalendarDate,
    on: CalendarDate,
    db: LedgerDb = this.prisma,
  ): Promise<number> {
    return availableOn(await this.input(employee, today, db), on) / 2;
  }

  /** «Баланс сегодня» в днях (RULES §6-6): тот же расчёт, что `balance` у `/me/balance`. */
  async balanceTodayDays(
    employee: Pick<AuthUser, 'id' | 'hireDate'>,
    today: CalendarDate,
  ): Promise<number> {
    return balanceToday(await this.input(employee, today)) / 2;
  }

  /** Остаток на сегодня и, если задана дата `on` (уже проверенная), «доступно на дату». */
  async view(
    employee: Pick<AuthUser, 'id' | 'hireDate'>,
    on?: CalendarDate,
  ): Promise<BalanceView> {
    const today = await this.today();
    const input = await this.input(employee, today);
    return {
      employeeId: employee.id,
      today,
      balance: balanceToday(input) / 2,
      on: on ?? null,
      availableOn: on === undefined ? null : availableOn(input, on) / 2,
    };
  }
}
