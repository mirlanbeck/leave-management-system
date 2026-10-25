import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { OrgService, type EmployeeRef } from './org.service';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly org: OrgService) {}

  /** Справочник для выбора backstopper любому вошедшему (RULES §3-3). */
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<EmployeeRef[]> {
    return this.org.directory(user.id);
  }
}
