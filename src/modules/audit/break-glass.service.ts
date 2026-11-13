import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export const RequestBreakGlassSchema = z.object({
  target_user_id: z.string().uuid(),
  reason: z.string().trim().min(20).max(1000),
  approved_by: z.string().trim().min(3).max(120),
  duration_hours: z.coerce.number().int().min(1).max(24).default(24),
  scope: z.literal('READ_AUDIT_LOGS').default('READ_AUDIT_LOGS'),
});

export type RequestBreakGlassDto = z.infer<typeof RequestBreakGlassSchema>;

export function redactAttachmentUrls(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactAttachmentUrls);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(storage_key|access_url)/i.test(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactAttachmentUrls(v);
      }
    }
    return result;
  }
  return value;
}

// shortcut: HTTP email webhook + structured log until production SMTP/Resend wired in TASK-122
export async function sendSecurityAlertEmail(
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const webhookUrl = process.env.EMAIL_WEBHOOK_URL;
  if (!webhookUrl) {
    Logger.warn(
      `[SecurityAlertEmail] EMAIL_WEBHOOK_URL not configured. Alert for ${to}: ${subject}`,
      'BreakGlassService',
    );
    return;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, text }),
    });
    if (!res.ok) {
      Logger.warn(
        `[SecurityAlertEmail] Webhook responded with status ${res.status} for ${to}`,
        'BreakGlassService',
      );
    }
  } catch (err) {
    Logger.error(
      `[SecurityAlertEmail] Failed to send email webhook to ${to}: ${(err as Error).message}`,
      undefined,
      'BreakGlassService',
    );
  }
}

@Injectable()
export class BreakGlassService {
  private readonly logger = new Logger(BreakGlassService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  verifyApprovalSecret(approvalHeader?: string): void {
    const secret = process.env.BREAK_GLASS_APPROVAL_SECRET;
    if (!secret || secret.trim() === '') {
      throw new ServiceUnavailableException({
        code: 'BREAK_GLASS_DISABLED',
        message: 'Fitur break-glass belum diaktifkan di environment',
      });
    }

    if (!approvalHeader || typeof approvalHeader !== 'string') {
      throw new ForbiddenException({
        code: 'INVALID_BREAK_GLASS_APPROVAL',
        message: 'Header X-Break-Glass-Approval tidak valid',
      });
    }

    const expectedHash = createHash('sha256').update(secret).digest();
    const actualHash = createHash('sha256').update(approvalHeader).digest();

    if (!timingSafeEqual(actualHash, expectedHash)) {
      throw new ForbiddenException({
        code: 'INVALID_BREAK_GLASS_APPROVAL',
        message: 'Header X-Break-Glass-Approval tidak valid',
      });
    }
  }

  async requestAccess(
    adminUserId: string,
    dto: RequestBreakGlassDto,
    approvalHeader?: string,
  ) {
    this.verifyApprovalSecret(approvalHeader);

    if (adminUserId === dto.target_user_id) {
      throw new BadRequestException({
        code: 'CANNOT_TARGET_SELF',
        message: 'Superadmin tidak dapat membuat akses break-glass ke dirinya sendiri',
      });
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: dto.target_user_id },
    });
    if (!targetUser) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'Target user tidak ditemukan',
      });
    }

    const now = new Date();
    const durationHours = dto.duration_hours ?? 24;
    const expiresAt = new Date(now.getTime() + durationHours * 3600_000);

    const grant = await this.prisma.asSystem().adminPiiAccessLog.create({
      data: {
        admin_user_id: adminUserId,
        target_user_id: dto.target_user_id,
        reason: dto.reason,
        approved_by: dto.approved_by,
        scope: dto.scope ?? 'READ_AUDIT_LOGS',
        granted_at: now,
        expires_at: expiresAt,
      },
    });

    await this.prisma.asSystem().auditLog.create({
      data: {
        action: 'BREAK_GLASS_GRANTED',
        resource_type: 'admin_pii_access_log',
        resource_id: grant.id,
        actor_user_id: adminUserId,
        actor_role: 'SUPERADMIN',
        after: {
          grant_id: grant.id,
          target_user_id: grant.target_user_id,
          reason: grant.reason,
          approved_by: grant.approved_by,
          duration_hours: durationHours,
          expires_at: expiresAt.toISOString(),
          scope: grant.scope,
        },
      },
    });

    await this.notificationsService.dispatch({
      userId: dto.target_user_id,
      type: 'SECURITY_ALERT',
      title: 'Peringatan Keamanan: Akses Darurat Superadmin Disetujui',
      body: `Akses darurat untuk akun Anda telah disetujui oleh ${dto.approved_by} hingga ${expiresAt.toISOString()}. Alasan: ${dto.reason}`,
      data: {
        grant_id: grant.id,
        approved_by: dto.approved_by,
        expires_at: expiresAt.toISOString(),
        reason: dto.reason,
      },
    });

    try {
      await sendSecurityAlertEmail(
        targetUser.email,
        'Peringatan Keamanan: Akses Darurat Superadmin Disetujui',
        `Akses darurat untuk akun Anda telah disetujui oleh ${dto.approved_by} dan berlaku hingga ${expiresAt.toISOString()}.\nAlasan: ${dto.reason}`,
      );
    } catch (emailErr) {
      this.logger.warn(
        `Failed to dispatch security alert email: ${(emailErr as Error).message ?? String(emailErr)}`,
      );
    }

    return grant;
  }

  async revokeAccess(adminUserId: string, grantId: string) {
    const grant = await this.prisma.asSystem().adminPiiAccessLog.findUnique({
      where: { id: grantId },
    });
    if (!grant) {
      throw new NotFoundException({
        code: 'GRANT_NOT_FOUND',
        message: 'Grant break-glass tidak ditemukan',
      });
    }

    if (grant.admin_user_id !== adminUserId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Akses break-glass bukan milik Anda',
      });
    }

    const now = new Date();
    const updated = await this.prisma.asSystem().adminPiiAccessLog.update({
      where: { id: grant.id },
      data: {
        revoked_at: grant.revoked_at ?? now,
      },
    });

    await this.prisma.asSystem().auditLog.create({
      data: {
        action: 'BREAK_GLASS_REVOKED',
        resource_type: 'admin_pii_access_log',
        resource_id: grant.id,
        actor_user_id: adminUserId,
        actor_role: 'SUPERADMIN',
        after: {
          revoked_at: (grant.revoked_at ?? now).toISOString(),
        },
      },
    });

    return updated;
  }

  @Cron('*/15 * * * *')
  async autoRevokeExpired(now: Date = new Date()): Promise<number> {
    const expiredGrants = await this.prisma.asSystem().adminPiiAccessLog.findMany({
      where: {
        revoked_at: null,
        expires_at: {
          lte: now,
        },
      },
    });

    for (const grant of expiredGrants) {
      await this.prisma.asSystem().adminPiiAccessLog.update({
        where: { id: grant.id },
        data: { revoked_at: now },
      });

      await this.prisma.asSystem().auditLog.create({
        data: {
          action: 'BREAK_GLASS_AUTO_REVOKED',
          resource_type: 'admin_pii_access_log',
          resource_id: grant.id,
          actor_user_id: null,
          actor_role: 'SYSTEM',
          after: {
            revoked_at: now.toISOString(),
          },
        },
      });
    }

    return expiredGrants.length;
  }

  async readTargetAuditLogs(adminUserId: string, grantId: string) {
    const grant = await this.prisma.asSystem().adminPiiAccessLog.findUnique({
      where: { id: grantId },
    });
    if (!grant) {
      throw new NotFoundException({
        code: 'GRANT_NOT_FOUND',
        message: 'Grant break-glass tidak ditemukan',
      });
    }

    if (grant.admin_user_id !== adminUserId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Akses break-glass bukan milik Anda',
      });
    }

    if (grant.revoked_at !== null) {
      throw new ForbiddenException({
        code: 'BREAK_GLASS_REVOKED',
        message: 'Akses break-glass telah dicabut',
      });
    }

    const now = new Date();
    if (grant.expires_at <= now) {
      await this.prisma.asSystem().adminPiiAccessLog.update({
        where: { id: grant.id },
        data: { revoked_at: now },
      });
      throw new ForbiddenException({
        code: 'BREAK_GLASS_EXPIRED',
        message: 'Akses break-glass telah kedaluwarsa',
      });
    }

    await this.prisma.asSystem().auditLog.create({
      data: {
        action: 'BREAK_GLASS_ACCESS',
        resource_type: 'admin_pii_access_log',
        resource_id: grant.id,
        actor_user_id: adminUserId,
        actor_role: 'SUPERADMIN',
        after: {
          target_user_id: grant.target_user_id,
          accessed_at: now.toISOString(),
        },
      },
    });

    const logs = await this.prisma.asSystem().auditLog.findMany({
      where: {
        actor_user_id: grant.target_user_id,
      },
      orderBy: [
        { created_at: 'desc' },
        { id: 'desc' },
      ],
    });

    return logs.map((log) => ({
      ...log,
      before: redactAttachmentUrls(log.before),
      after: redactAttachmentUrls(log.after),
    }));
  }
}
