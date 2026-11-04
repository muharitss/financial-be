import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';

export function redactNominalValues(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactNominalValues);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(amount|balance|fee)/i.test(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactNominalValues(v);
      }
    }
    return result;
  }
  return value;
}

@Injectable()
export class HardDeleteService implements OnModuleInit {
  private readonly logger = new Logger(HardDeleteService.name);

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'production' && !process.env.AUDIT_PSEUDONYM_SALT) {
      throw new Error('AUDIT_PSEUDONYM_SALT environment variable is required in production');
    }
  }

  async runHardDelete(now = new Date()): Promise<{ deletedCount: number; errors: number }> {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const salt = process.env.AUDIT_PSEUDONYM_SALT || '';

    const pendingUsers = await this.prisma.asSystem().user.findMany({
      where: {
        status: 'PENDING_DELETION',
        deleted_at: {
          lte: cutoff,
        },
      },
    });

    let deletedCount = 0;
    let errors = 0;

    for (const user of pendingUsers) {
      try {
        await this.prisma.asSystem().$transaction(async (tx) => {
          // 1. Anonimisasi audit_logs milik user
          const logs = await tx.auditLog.findMany({
            where: { actor_user_id: user.id },
          });

          const hashedActorId = createHash('sha256')
            .update(`${salt}:${user.id}`)
            .digest('hex');

          for (const log of logs) {
            await tx.auditLog.update({
              where: { id: log.id },
              data: {
                actor_user_id: hashedActorId,
                before: redactNominalValues(log.before) as any,
                after: redactNominalValues(log.after) as any,
              },
            });
          }

          // shortcut: Cloudinary cleanup diintegrasikan pada TASK-090 FilesService

          // 3. Hapus baris User
          await tx.user.delete({
            where: { id: user.id },
          });
        });

        deletedCount++;
      } catch (err) {
        this.logger.error(`Failed to hard delete user ${user.id}:`, err);
        errors++;
      }
    }

    return { deletedCount, errors };
  }
}
