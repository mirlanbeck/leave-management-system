import { Module } from '@nestjs/common';
import { APP_ENV } from '../config/app-config';
import { MailTransport, SmtpMailTransport } from './mail-transport';
import {
  OUTBOX_CONFIG,
  outboxConfig,
  type OutboxConfig,
} from './outbox-config';
import { OutboxDispatcher } from './outbox-dispatcher';
import { OutboxWorker } from './outbox-worker';

/** Отправка писем из outbox (architecture §10). Постановка в очередь - enqueueMail (outbox.ts). */
@Module({
  providers: [
    {
      provide: OUTBOX_CONFIG,
      inject: [APP_ENV],
      useFactory: (env: NodeJS.ProcessEnv) => outboxConfig(env),
    },
    {
      provide: MailTransport,
      inject: [OUTBOX_CONFIG],
      useFactory: (config: OutboxConfig) => new SmtpMailTransport(config),
    },
    OutboxDispatcher,
    OutboxWorker,
  ],
  exports: [OutboxDispatcher],
})
export class MailModule {}
