import { Global, Module } from '@nestjs/common';
import { APP_ENV } from './app-config';
import { ConfigController } from './config.controller';

@Global()
@Module({
  controllers: [ConfigController],
  providers: [{ provide: APP_ENV, useFactory: () => process.env }],
  exports: [APP_ENV],
})
export class AppConfigModule {}
