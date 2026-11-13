import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import {
  AuditService,
  redactAuditSnapshotForSuperadmin,
} from './audit.service.js';
import {
  PrismaService,
  validateAuditAppendOnly,
} from '../../prisma/prisma.service.js';
import { SuperadminGuard } from '../../common/guards/superadmin.guard.js';

describe('AuditService & Audit Protection Spec', () => {
  describe('redactAuditSnapshotForSuperadmin (FR-AUDIT-008 & AC-2)', () => {
    it('mengembalikan null atau undefined apa adanya', () => {
      expect(redactAuditSnapshotForSuperadmin(null)).toBeNull();
      expect(redactAuditSnapshotForSuperadmin(undefined)).toBeUndefined();
    });

    it('mengembalikan tipe primitif apa adanya', () => {
      expect(redactAuditSnapshotForSuperadmin('string')).toBe('string');
      expect(redactAuditSnapshotForSuperadmin(123)).toBe(123);
      expect(redactAuditSnapshotForSuperadmin(true)).toBe(true);
    });

    it('AC-2: me-redact field finansial dan rahasia serta mempertahankan field non-sensitif', () => {
      const dbSnapshot = {
        amount: 500000,
        balance: 1500000,
        fee: 6500,
        note: 'beli makan',
        storage_key: 'users/123/receipt.jpg',
        action: 'TRANSACTION_CREATE',
        actor_user_id: 'usr-1',
      };

      const redacted = redactAuditSnapshotForSuperadmin(dbSnapshot) as any;

      expect(redacted.amount).toBe('[REDACTED]');
      expect(redacted.balance).toBe('[REDACTED]');
      expect(redacted.fee).toBe('[REDACTED]');
      expect(redacted.note).toBe('[REDACTED]');
      expect(redacted.storage_key).toBe('[REDACTED]');
      expect(redacted.action).toBe('TRANSACTION_CREATE');
      expect(redacted.actor_user_id).toBe('usr-1');
    });

    it('me-redact seluruh kata kunci: reserved, available, carryover, nominal, target, spent, remaining, access_url', () => {
      const data = {
        reserved_amount: 10000,
        available_balance: 50000,
        carryover: 5000,
        nominal_transaksi: 20000,
        target_amount: 100000,
        spent_amount: 40000,
        remaining_balance: 60000,
        access_url: 'https://cdn.example.com/file',
        category: 'Food',
      };

      const redacted = redactAuditSnapshotForSuperadmin(data) as any;
      expect(redacted.reserved_amount).toBe('[REDACTED]');
      expect(redacted.available_balance).toBe('[REDACTED]');
      expect(redacted.carryover).toBe('[REDACTED]');
      expect(redacted.nominal_transaksi).toBe('[REDACTED]');
      expect(redacted.target_amount).toBe('[REDACTED]');
      expect(redacted.spent_amount).toBe('[REDACTED]');
      expect(redacted.remaining_balance).toBe('[REDACTED]');
      expect(redacted.access_url).toBe('[REDACTED]');
      expect(redacted.category).toBe('Food');
    });

    it('bekerja secara rekursif pada nested object dan array', () => {
      const nested = {
        items: [
          { amount: 100, label: 'item 1' },
          { amount: 200, label: 'item 2' },
        ],
        details: {
          fee: 50,
          currency: 'IDR',
        },
      };

      const redacted = redactAuditSnapshotForSuperadmin(nested) as any;
      expect(redacted.items[0].amount).toBe('[REDACTED]');
      expect(redacted.items[0].label).toBe('item 1');
      expect(redacted.items[1].amount).toBe('[REDACTED]');
      expect(redacted.items[1].label).toBe('item 2');
      expect(redacted.details.fee).toBe('[REDACTED]');
      expect(redacted.details.currency).toBe('IDR');
    });
  });

  describe('SuperadminGuard (AC-1)', () => {
    let guard: SuperadminGuard;

    beforeEach(() => {
      guard = new SuperadminGuard();
    });

    it('mengizinkan request jika user memiliki role SUPERADMIN', () => {
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({
            user: { userId: 'admin-uuid', role: 'SUPERADMIN' },
          }),
        }),
      } as unknown as ExecutionContext;

      expect(guard.canActivate(context)).toBe(true);
    });

    it('menolak request dengan 403 SUPERADMIN_REQUIRED jika role bukan SUPERADMIN', () => {
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({
            user: { userId: 'user-uuid', role: 'USER' },
          }),
        }),
      } as unknown as ExecutionContext;

      try {
        guard.canActivate(context);
        throw new Error('should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err.getResponse()).toEqual({
          code: 'SUPERADMIN_REQUIRED',
          message: 'Akses khusus Superadmin',
        });
      }
    });

    it('menolak request jika req.user tidak ada', () => {
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({}),
        }),
      } as unknown as ExecutionContext;

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Append-Only Guard (FR-AUDIT-006 & AC-4)', () => {
    it('menolak operasi update/delete/upsert pada model AuditLog dan TransactionAudit', () => {
      const forbiddenModels = ['AuditLog', 'auditlog', 'TransactionAudit', 'transactionaudit'];
      const forbiddenOps = ['update', 'updateMany', 'delete', 'deleteMany', 'upsert'];

      for (const model of forbiddenModels) {
        for (const op of forbiddenOps) {
          expect(() => validateAuditAppendOnly(model, op)).toThrow(ForbiddenException);
          try {
            validateAuditAppendOnly(model, op);
          } catch (err: any) {
            expect(err.getResponse()).toEqual({
              code: 'AUDIT_LOG_IMMUTABLE',
              message: 'Audit log bersifat append-only',
            });
          }
        }
      }
    });

    it('mengizinkan operasi create/findMany pada AuditLog dan TransactionAudit', () => {
      expect(() => validateAuditAppendOnly('AuditLog', 'create')).not.toThrow();
      expect(() => validateAuditAppendOnly('AuditLog', 'findMany')).not.toThrow();
      expect(() => validateAuditAppendOnly('TransactionAudit', 'create')).not.toThrow();
      expect(() => validateAuditAppendOnly('TransactionAudit', 'findMany')).not.toThrow();
    });

    it('mengizinkan operasi update/delete pada model lain', () => {
      expect(() => validateAuditAppendOnly('User', 'update')).not.toThrow();
      expect(() => validateAuditAppendOnly('User', 'delete')).not.toThrow();
      expect(() => validateAuditAppendOnly('Account', 'updateMany')).not.toThrow();
    });
  });

  describe('AuditService.queryLogs (AC-3, AC-5)', () => {
    let service: AuditService;
    let prisma: any;

    beforeEach(async () => {
      prisma = {
        auditLog: {
          create: jest.fn().mockImplementation((args: any) => Promise.resolve({ id: 'meta-log-1', ...args.data })),
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AuditService,
          {
            provide: PrismaService,
            useValue: prisma,
          },
        ],
      }).compile();

      service = module.get<AuditService>(AuditService);
    });

    it('AC-3: menulis baris AuditLog baru dengan action AUDIT_LOG_QUERY, hashed IP (64 hex), dan after { query }', async () => {
      const admin = { userId: 'superadmin-1', role: 'SUPERADMIN' };
      const query = { action: 'LOGIN', limit: 20 };
      const reqMeta = { ip: '192.168.1.100', userAgent: 'Mozilla/5.0 Test' };

      await service.queryLogs(admin, query, reqMeta);

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const createCall = prisma.auditLog.create.mock.calls[0][0];
      expect(createCall.data.action).toBe('AUDIT_LOG_QUERY');
      expect(createCall.data.resource_type).toBe('audit_log');
      expect(createCall.data.actor_user_id).toBe('superadmin-1');
      expect(createCall.data.actor_role).toBe('SUPERADMIN');
      expect(createCall.data.after).toEqual({ query });
      expect(createCall.data.ip_address).toMatch(/^[0-9a-f]{64}$/);
      expect(createCall.data.user_agent).toBe('Mozilla/5.0 Test');
    });

    it('memotong user_agent jika lebih dari 255 karakter', async () => {
      const admin = { userId: 'admin-1', role: 'SUPERADMIN' };
      const longAgent = 'a'.repeat(300);
      await service.queryLogs(admin, {}, { ip: '127.0.0.1', userAgent: longAgent });

      const createCall = prisma.auditLog.create.mock.calls[0][0];
      expect(createCall.data.user_agent).toHaveLength(255);
    });

    it('AC-5: menerapkan filter actor_user_id, action, resource_type, resource_id, from, to', async () => {
      const admin = { userId: 'admin-1', role: 'SUPERADMIN' };
      const query = {
        actor_user_id: 'usr-1',
        action: 'UPDATE_PASSWORD',
        resource_type: 'user',
        resource_id: 'usr-1',
        from: '2026-11-01',
        to: '2026-11-30',
        limit: 10,
      };

      await service.queryLogs(admin, query);

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          actor_user_id: 'usr-1',
          action: 'UPDATE_PASSWORD',
          resource_type: 'user',
          resource_id: 'usr-1',
          created_at: {
            gte: new Date('2026-11-01T00:00:00.000Z'),
            lte: new Date('2026-11-30T23:59:59.999Z'),
          },
        },
        take: 11,
        orderBy: [
          { created_at: 'desc' },
          { id: 'desc' },
        ],
      });
    });

    it('AC-5: mendukung cursor pagination dan menghasilkan next_cursor', async () => {
      const admin = { userId: 'admin-1', role: 'SUPERADMIN' };
      const logs = [
        {
          id: 'log-1',
          actor_user_id: 'u1',
          actor_role: 'USER',
          action: 'LOGIN',
          resource_type: 'session',
          resource_id: null,
          before: null,
          after: { amount: 100 },
          ip_address: null,
          user_agent: null,
          created_at: new Date('2026-11-14T01:00:00Z'),
        },
        {
          id: 'log-2',
          actor_user_id: 'u1',
          actor_role: 'USER',
          action: 'LOGOUT',
          resource_type: 'session',
          resource_id: null,
          before: null,
          after: null,
          ip_address: null,
          user_agent: null,
          created_at: new Date('2026-11-14T00:50:00Z'),
        },
        {
          id: 'log-3',
          actor_user_id: 'u1',
          actor_role: 'USER',
          action: 'LOGIN',
          resource_type: 'session',
          resource_id: null,
          before: null,
          after: null,
          ip_address: null,
          user_agent: null,
          created_at: new Date('2026-11-14T00:40:00Z'),
        },
      ];

      prisma.auditLog.findMany.mockResolvedValueOnce(logs);

      // Page 1 with limit 2
      const res = await service.queryLogs(admin, { limit: 2 });
      expect(res.items).toHaveLength(2);
      expect(res.items[0].id).toBe('log-1');
      expect(res.items[0].after).toEqual({ amount: '[REDACTED]' });
      expect(res.next_cursor).toBe('log-2');

      // Page 2 with cursor log-2
      prisma.auditLog.findMany.mockResolvedValueOnce([logs[2]]);
      const res2 = await service.queryLogs(admin, { limit: 2, cursor: '00000000-0000-0000-0000-000000000002' });
      expect(res2.items).toHaveLength(1);
      expect(res2.items[0].id).toBe('log-3');
      expect(res2.next_cursor).toBeNull();
    });
  });
});
