import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SavingsService } from './savings.service.js';
import { SavingsController } from './savings.controller.js';
import { SavingsAchievementService } from './savings-achievement.service.js';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [SavingsController],
  providers: [SavingsService, SavingsAchievementService],
  exports: [SavingsService, SavingsAchievementService],
})
export class SavingsModule {}
