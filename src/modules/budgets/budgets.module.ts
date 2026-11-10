import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { BudgetsService } from './budgets.service.js';
import { BudgetsController } from './budgets.controller.js';
import { BudgetPeriodLockService } from './budget-period-lock.service.js';
import { BudgetRolloverService } from './budget-rollover.service.js';
import { BudgetWarningService } from './budget-warning.service.js';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [BudgetsController],
  providers: [
    BudgetsService,
    BudgetPeriodLockService,
    BudgetRolloverService,
    BudgetWarningService,
  ],
  exports: [
    BudgetsService,
    BudgetPeriodLockService,
    BudgetRolloverService,
    BudgetWarningService,
  ],
})
export class BudgetsModule {}
