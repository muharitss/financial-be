import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { SavingsService } from './savings.service.js';
import { SavingsController } from './savings.controller.js';

@Module({
  imports: [PrismaModule],
  controllers: [SavingsController],
  providers: [SavingsService],
  exports: [SavingsService],
})
export class SavingsModule {}
