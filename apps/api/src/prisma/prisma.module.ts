import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: () => new PrismaService(process.env.DATABASE_URL ?? ''),
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
