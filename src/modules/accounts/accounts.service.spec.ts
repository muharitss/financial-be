import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccountsService, toAccountResponse } from './accounts.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('AccountsService', () => {
  let service: AccountsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      financialProfile: {
        findFirst: jest.fn(),
      },
      userPreference: {
        findFirst: jest.fn(),
      },
      account: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AccountsService>(AccountsService);
  });

  describe('toAccountResponse', () => {
    it('mengonversi BigInt ke number dan memformat opening_date YYYY-MM-DD', () => {
      const mockAccount = {
        id: 'acc-1',
        name: 'BCA',
        type: 'BANK',
        provider: 'BCA',
        note: 'Gaji',
        opening_balance: 1000000n,
        opening_date: new Date('2026-11-04T00:00:00.000Z'),
        balance: 1000000n,
        allow_negative: false,
        archived: false,
        archived_at: null,
        created_at: new Date('2026-11-04T10:00:00.000Z'),
      };

      const res = toAccountResponse(mockAccount, 200000n);
      expect(res).toEqual({
        id: 'acc-1',
        name: 'BCA',
        type: 'BANK',
        provider: 'BCA',
        note: 'Gaji',
        opening_balance: 1000000,
        opening_date: '2026-11-04',
        balance: 1000000,
        reserved: 200000,
        available: 800000,
        allow_negative: false,
        archived: false,
        archived_at: null,
        created_at: mockAccount.created_at,
      });
    });
  });

  describe('create', () => {
    const user = { userId: 'user-1', role: 'USER' };
    const defaultProfile = { id: 'prof-1', user_id: 'user-1', is_default: true };

    it('berhasil membuat akun dengan saldo awal dan mencatat audit log', async () => {
      prisma.financialProfile.findFirst.mockResolvedValue(defaultProfile);
      prisma.userPreference.findFirst.mockResolvedValue({ timezone: 'Asia/Jakarta' });

      const createdAccount = {
        id: 'acc-1',
        name: 'BCA',
        type: 'BANK',
        provider: 'BCA',
        opening_balance: 1250000n,
        opening_date: new Date('2026-11-04T00:00:00.000Z'),
        balance: 1250000n,
        allow_negative: false,
        archived: false,
        archived_at: null,
        note: null,
        created_at: new Date(),
      };
      prisma.account.create.mockResolvedValue(createdAccount);
      prisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      const result = await service.create(user, {
        name: 'BCA',
        type: 'BANK' as any,
        provider: 'BCA',
        opening_balance: 1250000,
      });

      expect(result.id).toBe('acc-1');
      expect(result.balance).toBe(1250000);
      expect(result.reserved).toBe(0);
      expect(result.available).toBe(1250000);
      expect(result.allow_negative).toBe(false);
      expect(prisma.account.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id: 'user-1',
          financial_profile_id: 'prof-1',
          name: 'BCA',
          type: 'BANK',
          opening_balance: 1250000n,
          balance: 1250000n,
        }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'ACCOUNT_CREATE',
          resource_type: 'account',
          resource_id: 'acc-1',
          actor_user_id: 'user-1',
          actor_role: 'USER',
        }),
      });
    });

    it('melempar BadRequestException jika opening_date di masa depan', async () => {
      prisma.financialProfile.findFirst.mockResolvedValue(defaultProfile);
      prisma.userPreference.findFirst.mockResolvedValue({ timezone: 'Asia/Jakarta' });

      await expect(
        service.create(user, {
          name: 'BCA',
          type: 'BANK' as any,
          opening_balance: 10000,
          opening_date: '2099-01-01',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('melempar ConflictException jika nama akun sudah dipakai (P2002)', async () => {
      prisma.financialProfile.findFirst.mockResolvedValue(defaultProfile);
      prisma.userPreference.findFirst.mockResolvedValue(null);

      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      prisma.account.create.mockRejectedValue(p2002Error);

      await expect(
        service.create(user, {
          name: 'BCA',
          type: 'BANK' as any,
          opening_balance: 10000,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('melempar NotFoundException jika profil keuangan default tidak ada', async () => {
      prisma.financialProfile.findFirst.mockResolvedValue(null);

      await expect(
        service.create(user, {
          name: 'BCA',
          type: 'BANK' as any,
          opening_balance: 10000,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getOwnedAccount', () => {
    it('mengembalikan record account jika akun milik user', async () => {
      const mockAcc = { id: 'acc-1', user_id: 'user-1', name: 'Dompet' };
      prisma.account.findFirst.mockResolvedValue(mockAcc);

      const res = await service.getOwnedAccount('user-1', 'acc-1');
      expect(res).toBe(mockAcc);
    });

    it('AC-8: melempar 404 ACCOUNT_NOT_FOUND jika akun milik user lain atau tidak ditemukan', async () => {
      prisma.account.findFirst.mockResolvedValue(null);

      await expect(service.getOwnedAccount('user-B', 'acc-A')).rejects.toThrow(
        NotFoundException,
      );
      try {
        await service.getOwnedAccount('user-B', 'acc-A');
      } catch (err: any) {
        expect(err.getResponse()).toEqual({
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Akun tidak ditemukan',
        });
      }
    });
  });
});
