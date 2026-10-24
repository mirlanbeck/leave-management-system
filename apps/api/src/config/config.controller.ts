import { Controller, Get, Inject } from '@nestjs/common';
import { APP_ENV, publicConfig } from './app-config';
import type { PublicConfig } from './app-config';

@Controller('config')
export class ConfigController {
  constructor(@Inject(APP_ENV) private readonly env: NodeJS.ProcessEnv) {}

  /** Публичная конфигурация без авторизации: признак демо-режима и пояс компании. */
  @Get()
  get(): PublicConfig {
    return publicConfig(this.env);
  }
}
