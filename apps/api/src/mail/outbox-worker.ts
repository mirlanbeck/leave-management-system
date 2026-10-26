import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OUTBOX_CONFIG, type OutboxConfig } from './outbox-config';
import { OutboxDispatcher } from './outbox-dispatcher';

/**
 * Фоновый опрос outbox по системному таймеру (RULES §9-1): цепочка setTimeout, проходы не
 * накладываются. Остановка дожидается текущего прохода. В тестах подменяется (test-app.ts),
 * проходы вызываются явно через OutboxDispatcher.runOnce().
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.pass().finally(() => {
        this.running = undefined;
        this.schedule();
      });
    }, this.config.pollMs);
  }

  private async pass(): Promise<void> {
    try {
      await this.dispatcher.runOnce();
    } catch (error) {
      this.logger.error(
        `Проход outbox не выполнен: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
