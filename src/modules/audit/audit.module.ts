import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';
import { BreakGlassService } from './break-glass.service.js';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [AuditController],
  providers: [AuditService, BreakGlassService],
  exports: [AuditService, BreakGlassService],
})
export class AuditModule {}
