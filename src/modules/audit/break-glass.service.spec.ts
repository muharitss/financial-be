import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BreakGlassService,
  redactAttachmentUrls,
  sendSecurityAlertEmail,
  RequestBreakGlassSchema,
} from './break-glass.service.js';

describe('BreakGlassService', () => {
  let service: BreakGlassService;
  let mockPrisma: any;
  let mockNotificationsService: any;

  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.BREAK_GLASS_APPROVAL_SECRET = 'super-secret-approval-key-12345';

    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
      adminPiiAccessLog: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      asSystem: jest.fn().mockReturnThis(),
    };

    mockNotificationsService = {
      dispatch: jest.fn().mockResolvedValue({ id: 'notif-1' } as any),
    };

    service = new BreakGlassService(mockPrisma, mockNotificationsService);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('redactAttachmentUrls', () => {
    it('should return null or undefined as is', () => {
      expect(redactAttachmentUrls(null)).toBeNull();
      expect(redactAttachmentUrls(undefined)).toBeUndefined();
    });

    it('should redact storage_key and access_url in objects and nested arrays', () => {
      const input = {
        amount: 50000,
        note: 'lunch',
        storage_key: 'uploads/secret-file.png',
        access_url: 'https://cloudinary.com/secret.png',
        nested: {
          STORAGE_KEY: 'nested/key.jpg',
          title: 'ok',
        },
        items: [
          { access_url: 'https://item.png', name: 'item1' },
          { id: 1 },
        ],
      };

      const result = redactAttachmentUrls(input) as any;
      expect(result.amount).toBe(50000);
      expect(result.note).toBe('lunch');
      expect(result.storage_key).toBe('[REDACTED]');
      expect(result.access_url).toBe('[REDACTED]');
      expect(result.nested.STORAGE_KEY).toBe('[REDACTED]');
      expect(result.nested.title).toBe('ok');
      expect(result.items[0].access_url).toBe('[REDACTED]');
      expect(result.items[0].name).toBe('item1');
    });
  });

  describe('RequestBreakGlassSchema', () => {
    it('should reject reason shorter than 20 characters', () => {
      const data = {
        target_user_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        reason: 'Too short reason',
        approved_by: 'Owner',
        duration_hours: 24,
      };
      const parsed = RequestBreakGlassSchema.safeParse(data);
      expect(parsed.success).toBe(false);
    });

    it('should reject duration_hours greater than 24', () => {
      const data = {
        target_user_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        reason: 'Valid reason exceeding 20 characters long',
        approved_by: 'Owner',
        duration_hours: 25,
      };
      const parsed = RequestBreakGlassSchema.safeParse(data);
      expect(parsed.success).toBe(false);
    });

    it('should accept valid break glass request', () => {
      const data = {
        target_user_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        reason: 'Valid investigation reason with > 20 characters',
        approved_by: 'Project Owner',
        duration_hours: 12,
      };
      const parsed = RequestBreakGlassSchema.safeParse(data);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.scope).toBe('READ_AUDIT_LOGS');
        expect(parsed.data.duration_hours).toBe(12);
      }
    });
  });

  describe('verifyApprovalSecret', () => {
    it('should throw ServiceUnavailableException when secret is not set in env', () => {
      delete process.env.BREAK_GLASS_APPROVAL_SECRET;
      expect(() => service.verifyApprovalSecret('any-header')).toThrow(
        ServiceUnavailableException,
      );
    });

    it('should throw ForbiddenException when header is missing', () => {
      expect(() => service.verifyApprovalSecret(undefined)).toThrow(
        ForbiddenException,
      );
    });

    it('should throw ForbiddenException when header does not match secret', () => {
      expect(() => service.verifyApprovalSecret('wrong-secret-token')).toThrow(
        ForbiddenException,
      );
    });

    it('should pass without error when header matches secret', () => {
      expect(() =>
        service.verifyApprovalSecret('super-secret-approval-key-12345'),
      ).not.toThrow();
    });
  });

  describe('sendSecurityAlertEmail', () => {
    it('should not throw when EMAIL_WEBHOOK_URL is not set', async () => {
      delete process.env.EMAIL_WEBHOOK_URL;
      await expect(
        sendSecurityAlertEmail('user@test.com', 'Subject', 'Text'),
      ).resolves.toBeUndefined();
    });

    it('should call fetch and handle failure gracefully without throwing', async () => {
      process.env.EMAIL_WEBHOOK_URL = 'https://webhook.test/email';
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error') as never) as any;

      await expect(
        sendSecurityAlertEmail('user@test.com', 'Subject', 'Text'),
      ).resolves.toBeUndefined();

      global.fetch = originalFetch;
    });
  });

  describe('requestAccess', () => {
    const adminId = '11111111-1111-4111-8111-111111111111';
    const targetUserId = '22222222-2222-4222-8222-222222222222';
    const validDto = {
      target_user_id: targetUserId,
      reason: 'Pemeriksaan audit keamanan karena dugaan anomali transaksi',
      approved_by: 'Project Owner',
      duration_hours: 24,
      scope: 'READ_AUDIT_LOGS' as const,
    };

    it('should throw BadRequestException if admin targets own account', async () => {
      await expect(
        service.requestAccess(
          adminId,
          { ...validDto, target_user_id: adminId },
          'super-secret-approval-key-12345',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if target user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.requestAccess(
          adminId,
          validDto,
          'super-secret-approval-key-12345',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should create AdminPiiAccessLog, AuditLog, and dispatch SECURITY_ALERT notification', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: targetUserId,
        email: 'victim@duitku.app',
      });

      const mockGrant = {
        id: 'grant-uuid-123',
        admin_user_id: adminId,
        target_user_id: targetUserId,
        reason: validDto.reason,
        approved_by: validDto.approved_by,
        scope: validDto.scope,
        granted_at: new Date(),
        expires_at: new Date(Date.now() + 24 * 3600_000),
        revoked_at: null,
      };
      mockPrisma.adminPiiAccessLog.create.mockResolvedValue(mockGrant);
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-log-1' });

      const result = await service.requestAccess(
        adminId,
        validDto,
        'super-secret-approval-key-12345',
      );

      expect(result).toEqual(mockGrant);
      expect(mockPrisma.adminPiiAccessLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            admin_user_id: adminId,
            target_user_id: targetUserId,
            reason: validDto.reason,
            approved_by: validDto.approved_by,
          }),
        }),
      );

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'BREAK_GLASS_GRANTED',
            resource_type: 'admin_pii_access_log',
            resource_id: 'grant-uuid-123',
            actor_user_id: adminId,
            actor_role: 'SUPERADMIN',
          }),
        }),
      );

      expect(mockNotificationsService.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: targetUserId,
          type: 'SECURITY_ALERT',
        }),
      );
    });
  });

  describe('revokeAccess', () => {
    const adminId = '11111111-1111-4111-8111-111111111111';

    it('should throw NotFoundException if grant does not exist', async () => {
      mockPrisma.adminPiiAccessLog.findUnique.mockResolvedValue(null);

      await expect(service.revokeAccess(adminId, 'non-existent-grant')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException if grant belongs to another admin', async () => {
      mockPrisma.adminPiiAccessLog.findUnique.mockResolvedValue({
        id: 'grant-1',
        admin_user_id: 'other-admin-id',
      });

      await expect(service.revokeAccess(adminId, 'grant-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should update revoked_at and create AuditLog BREAK_GLASS_REVOKED', async () => {
      const grant = {
        id: 'grant-1',
        admin_user_id: adminId,
        revoked_at: null,
      };
      mockPrisma.adminPiiAccessLog.findUnique.mockResolvedValue(grant);
      mockPrisma.adminPiiAccessLog.update.mockResolvedValue({
        ...grant,
        revoked_at: new Date(),
      });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      const updated = await service.revokeAccess(adminId, 'grant-1');
      expect(updated.revoked_at).toBeDefined();

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'BREAK_GLASS_REVOKED',
            resource_type: 'admin_pii_access_log',
            actor_user_id: adminId,
          }),
        }),
      );
    });
  });

  describe('autoRevokeExpired', () => {
    it('should revoke all grants where expires_at <= now and create BREAK_GLASS_AUTO_REVOKED log', async () => {
      const now = new Date();
      const expired = [
        { id: 'grant-1', expires_at: new Date(now.getTime() - 1000) },
        { id: 'grant-2', expires_at: new Date(now.getTime() - 5000) },
      ];
      mockPrisma.adminPiiAccessLog.findMany.mockResolvedValue(expired);
      mockPrisma.adminPiiAccessLog.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const count = await service.autoRevokeExpired(now);
      expect(count).toBe(2);
      expect(mockPrisma.adminPiiAccessLog.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'BREAK_GLASS_AUTO_REVOKED',
          }),
        }),
      );
    });
  });

  describe('readTargetAuditLogs', () => {
    const adminId = '11111111-1111-4111-8111-111111111111';
    const targetUserId = '22222222-2222-4222-8222-222222222222';

    it('should throw NotFoundException if grant does not exist', async () => {
      mockPrisma.adminPiiAccessLog.findUnique.mockResolvedValue(null);
      await expect(service.readTargetAuditLogs(adminId, 'non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException if grant belongs to another admin', async () => {
      mockPrisma.adminPiiAccessLog.findUnique.mockResolvedValue({
        id: 'grant-1',
        admin_user_id: 'another-admin',
      });
      await expect(service.readTargetAuditLogs(adminId, 'grant-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw ForbiddenException BREAK_GLASS_REVOKED if already revoked', async () => {
      mockPrisma.adminPiiAccessLog.findUnique.mockResolvedValue({
        id: 'grant-1',
        admin_user_id: adminId,
        revoked_at: new Date(),
        expires_at: new Date(Date.now() + 10000),
      });

      try {
        await service.readTargetAuditLogs(adminId, 'grant-1');
        throw new Error('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err.getResponse().code).toBe('BREAK_GLASS_REVOKED');
      }
    });

    it('should set revoked_at and throw BREAK_GLASS_EXPIRED if past expires_at', async () => {
      mockPrisma.adminPiiAccessLog.findUnique.mockResolvedValue({
        id: 'grant-1',
        admin_user_id: adminId,
        revoked_at: null,
        expires_at: new Date(Date.now() - 5000),
      });
      mockPrisma.adminPiiAccessLog.update.mockResolvedValue({});

      try {
        await service.readTargetAuditLogs(adminId, 'grant-1');
        throw new Error('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err.getResponse().code).toBe('BREAK_GLASS_EXPIRED');
        expect(mockPrisma.adminPiiAccessLog.update).toHaveBeenCalled();
      }
    });

    it('should record BREAK_GLASS_ACCESS and return target logs with redacted attachments', async () => {
      mockPrisma.adminPiiAccessLog.findUnique.mockResolvedValue({
        id: 'grant-1',
        admin_user_id: adminId,
        target_user_id: targetUserId,
        revoked_at: null,
        expires_at: new Date(Date.now() + 3600_000),
      });

      mockPrisma.auditLog.create.mockResolvedValue({});
      mockPrisma.auditLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          actor_user_id: targetUserId,
          action: 'TRANSACTION_CREATE',
          before: null,
          after: {
            amount: 50000,
            storage_key: 'users/receipt.jpg',
            access_url: 'https://cloudinary.com/secret.jpg',
          },
        },
      ]);

      const logs = await service.readTargetAuditLogs(adminId, 'grant-1');
      expect(logs).toHaveLength(1);
      expect((logs[0].after as any).storage_key).toBe('[REDACTED]');
      expect((logs[0].after as any).access_url).toBe('[REDACTED]');
      expect((logs[0].after as any).amount).toBe(50000);

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'BREAK_GLASS_ACCESS',
            actor_user_id: adminId,
            actor_role: 'SUPERADMIN',
          }),
        }),
      );
    });
  });
});
