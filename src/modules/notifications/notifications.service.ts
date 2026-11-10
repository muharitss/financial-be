import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationType, Notification } from '@prisma/client';

export interface DispatchNotificationDto {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: any;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async dispatch(
    dto: DispatchNotificationDto,
    tx?: any,
  ): Promise<Notification> {
    const client = tx ?? this.prisma.asSystem();

    // shortcut: web push and quiet hours deferred to TASK-092, implement in Phase 8
    return client.notification.create({
      data: {
        user_id: dto.userId,
        type: dto.type,
        title: dto.title,
        body: dto.body,
        data: dto.data ?? null,
      },
    });
  }
}
