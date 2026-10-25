import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { OrgService, type Profile } from './org.service';

@Controller('me')
export class MeController {
  constructor(private readonly org: OrgService) {}

  /** Профиль только на чтение (RULES §7-2, §7-6). */
  @Get()
  get(@CurrentUser() user: AuthUser): Promise<Profile> {
    return this.org.profile(user);
  }
}
