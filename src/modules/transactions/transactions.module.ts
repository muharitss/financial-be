import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { BudgetsModule } from '../budgets/budgets.module.js';
import { TransactionsController } from './transactions.controller.js';
import { AccountAdjustController } from './account-adjust.controller.js';
import { TransactionsService } from './transactions.service.js';
import { ScheduledTransactionService } from './scheduled-transaction.service.js';
import { TransactionAttachmentsController } from './transaction-attachments.controller.js';
import { TransactionAttachmentsService } from './transaction-attachments.service.js';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor.js';

@Module({
  imports: [PrismaModule, BudgetsModule],
  controllers: [
    TransactionsController,
    AccountAdjustController,
    TransactionAttachmentsController,
  ],
  providers: [
    TransactionsService,
    ScheduledTransactionService,
    TransactionAttachmentsService,
    IdempotencyInterceptor,
  ],
  exports: [
    TransactionsService,
    ScheduledTransactionService,
    TransactionAttachmentsService,
    IdempotencyInterceptor,
  ],
})
export class TransactionsModule {}
