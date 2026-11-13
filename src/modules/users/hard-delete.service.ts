import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CloudinaryService } from '../files/cloudinary.service.js';

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

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly cloudinaryService?: CloudinaryService,
  ) {}

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
      let userStorageKeys: string[] = [];
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

          // Ambil semua storage_key milik user sebelum tx.user.delete
          if (tx.fileAttachment) {
            const attachments = await tx.fileAttachment.findMany({
              where: { uploaded_by: user.id },
              select: { storage_key: true },
            });
            userStorageKeys = attachments.map((a) => a.storage_key);
          }

          // 3. Hapus baris User
          await tx.user.delete({
            where: { id: user.id },
          });
        });

        if (this.cloudinaryService && userStorageKeys.length > 0) {
          for (const key of userStorageKeys) {
            try {
              await this.cloudinaryService.destroy(key);
            } catch (destroyErr) {
              this.logger.warn(
                `Failed to destroy Cloudinary file ${key} for user ${user.id}:`,
                destroyErr,
              );
            }
          }
        }

        deletedCount++;
      } catch (err) {
        this.logger.error(`Failed to hard delete user ${user.id}:`, err);
        errors++;
      }
    }

    return { deletedCount, errors };
  }
}
