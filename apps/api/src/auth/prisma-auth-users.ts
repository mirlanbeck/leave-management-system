import { Injectable } from '@nestjs/common';
import { fromDbDate } from '../domain/calendar-date';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, AuthUsers } from './auth-user';

@Injectable()
export class PrismaAuthUsers extends AuthUsers {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findById(id: number): Promise<AuthUser | null> {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) return null;
    return {
      id: u.id,
      login: u.login,
      fullName: u.fullName,
      hireDate: fromDbDate(u.hireDate),
      teamName: u.teamName,
      managerId: u.managerId,
      isHr: u.isHr,
      accessGranted: u.accessGranted,
    };
  }
}
