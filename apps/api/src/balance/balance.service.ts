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
import { PrismaService } from '../prisma/prisma.service';

export interface BalanceView {
  employeeId: number;
  today: CalendarDate;
  /** Дни кратно 0,5; минус только после сдвига даты выхода (RULES §6-4). */
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

  /** Все списания и возвраты сотрудника, независимо от даты (RULES §6-6). */
  async ledgerOf(employeeId: number): Promise<LedgerAction[]> {
    const rows = await this.prisma.ledgerEntry.findMany({
      where: { vacation: { employeeId } },
      select: { kind: true, halfDays: true, occurredAt: true },
    });
    return rows;
  }

  async input(
    employee: Pick<AuthUser, 'id' | 'hireDate'>,
    today: CalendarDate,
  ): Promise<BalanceInput> {
    return {
      hireDate: employee.hireDate,
      ledger: await this.ledgerOf(employee.id),
      today,
      tz: companyTz(this.env),
    };
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
