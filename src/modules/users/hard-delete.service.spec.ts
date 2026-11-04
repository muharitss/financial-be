import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import {
  HardDeleteService,
  redactNominalValues,
} from './hard-delete.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('HardDeleteService', () => {
  let service: HardDeleteService;
  let prisma: any;
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };

    prisma = {
      user: {
        findMany: jest.fn(),
        delete: jest.fn(),
      },
      auditLog: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      asSystem: jest.fn(() => prisma),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HardDeleteService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<HardDeleteService>(HardDeleteService);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('onModuleInit', () => {
    it('melempar error jika production tanpa AUDIT_PSEUDONYM_SALT', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.AUDIT_PSEUDONYM_SALT;

      expect(() => service.onModuleInit()).toThrow(
        /AUDIT_PSEUDONYM_SALT environment variable is required in production/,
      );
    });

    it('tidak melempar error jika development tanpa AUDIT_PSEUDONYM_SALT', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.AUDIT_PSEUDONYM_SALT;

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('tidak melempar error jika production dengan AUDIT_PSEUDONYM_SALT', () => {
      process.env.NODE_ENV = 'production';
      process.env.AUDIT_PSEUDONYM_SALT = 'super-secret-salt-min-32-chars-long';

      expect(() => service.onModuleInit()).not.toThrow();
    });
  });

  describe('redactNominalValues', () => {
    it('me-redact field amount, balance, fee, reserved_amount pada objek nested dan array', () => {
      const input = {
        id: 'tx-1',
        amount: 50000,
        balance: 1000000,
        fee: 2500,
        reserved_amount: 10000,
        note: 'Beli makan',
        nested: {
          current_amount: 25000,
          status: 'POSTED',
        },
        items: [{ transfer_fee: 1000, item_name: 'Transfer' }],
      };

      const result = redactNominalValues(input) as any;

      expect(result.id).toBe('tx-1');
      expect(result.amount).toBe('[REDACTED]');
      expect(result.balance).toBe('[REDACTED]');
      expect(result.fee).toBe('[REDACTED]');
      expect(result.reserved_amount).toBe('[REDACTED]');
      expect(result.note).toBe('Beli makan');
      expect(result.nested.current_amount).toBe('[REDACTED]');
      expect(result.nested.status).toBe('POSTED');
      expect(result.items[0].transfer_fee).toBe('[REDACTED]');
      expect(result.items[0].item_name).toBe('Transfer');
    });

    it('mengembalikan nilai primitif tanpa perubahan jika bukan objek', () => {
      expect(redactNominalValues(null)).toBeNull();
      expect(redactNominalValues(undefined)).toBeUndefined();
      expect(redactNominalValues('test')).toBe('test');
      expect(redactNominalValues(123)).toBe(123);
    });
  });

  describe('runHardDelete', () => {
    it('menghapus user yang deleted_at >= 30 hari, meng-hash actor_user_id, dan me-redact nominal audit logs', async () => {
      process.env.AUDIT_PSEUDONYM_SALT = 'test-salt-secret';
      const fixedNow = new Date('2026-06-01T00:00:00Z');

      const mockUser = {
        id: 'user-to-delete-1',
        email: 'deleted@example.com',
        status: 'PENDING_DELETION',
        deleted_at: new Date('2026-04-30T00:00:00Z'),
      };

      prisma.user.findMany.mockResolvedValue([mockUser]);

      const mockLogs = [
        {
          id: 'log-1',
          actor_user_id: 'user-to-delete-1',
          action: 'TRANSACTION_CREATE',
          before: null,
          after: { amount: 75000, balance: 200000, category: 'Food' },
        },
        {
          id: 'log-2',
          actor_user_id: 'user-to-delete-1',
          action: 'ACCOUNT_UPDATE',
          before: { balance: 150000 },
          after: { balance: 200000 },
        },
      ];

      prisma.auditLog.findMany.mockResolvedValue(mockLogs);
      prisma.auditLog.update.mockResolvedValue({});
      prisma.user.delete.mockResolvedValue(mockUser);

      const result = await service.runHardDelete(fixedNow);

      expect(result).toEqual({ deletedCount: 1, errors: 0 });

      // Verifikasi query cutoff 30 hari
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          status: 'PENDING_DELETION',
          deleted_at: {
            lte: new Date('2026-05-02T00:00:00Z'), // 30 hari sebelum 2026-06-01
          },
        },
      });

      // Verifikasi hash actor_user_id
      const expectedHash = createHash('sha256')
        .update('test-salt-secret:user-to-delete-1')
        .digest('hex');

      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'log-1' },
        data: {
          actor_user_id: expectedHash,
          before: null,
          after: {
            amount: '[REDACTED]',
            balance: '[REDACTED]',
            category: 'Food',
          },
        },
      });

      expect(prisma.auditLog.update).toHaveBeenCalledWith({
        where: { id: 'log-2' },
        data: {
          actor_user_id: expectedHash,
          before: { balance: '[REDACTED]' },
          after: { balance: '[REDACTED]' },
        },
      });

      // Verifikasi penghapusan baris User
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: 'user-to-delete-1' },
      });
    });

    it('melanjutkan proses jika satu user gagal dihapus', async () => {
      const users = [
        { id: 'user-fail', status: 'PENDING_DELETION' },
        { id: 'user-success', status: 'PENDING_DELETION' },
      ];

      prisma.user.findMany.mockResolvedValue(users);
      prisma.auditLog.findMany.mockResolvedValue([]);

      prisma.user.delete
        .mockRejectedValueOnce(new Error('DB Foreign Key constraint error'))
        .mockResolvedValueOnce({ id: 'user-success' });

      const result = await service.runHardDelete();

      expect(result).toEqual({ deletedCount: 1, errors: 1 });
    });
  });
});
