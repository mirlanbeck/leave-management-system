import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ProblemFilter } from './problem.filter';
import { createValidationPipe } from './validation';

// Фильтр и пайп подключены как провайдеры модуля (не в main.ts): тесты и прод идут одним путём.
@Module({
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class CommonModule {}
