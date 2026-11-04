import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  TransactionsService,
  toTransactionResponse,
  getAccountReserved,
} from './transactions.service.js';
import {
  resolveClientTxId,
} from './dto/transaction.dto.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let prisma: any;

  const validUlid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const user = { userId: '11111111-1111-1111-1111-111111111111', role: 'USER' };
  const mockAccount = {
    id: '22222222-2222-2222-2222-222222222222',
    financial_profile_id: '33333333-3333-3333-3333-333333333333',
    balance: 100000n,
    allow_negative: false,
    archived: false,
  };
  const mockCategory = {
    id: '44444444-4444-4444-4444-444444444444',
    type: 'INCOME',
    archived: false,
  };

  beforeEach(async () => {
    prisma = {
      userPreference: {
        findFirst: jest.fn<any>().mockResolvedValue({ timezone: 'Asia/Jakarta' }),
      },
      category: {
        findFirst: jest.fn<any>(),
      },
      tag: {
        findMany: jest.fn<any>(),
      },
      account: {
        update: jest.fn<any>(),
      },
      transaction: {
        create: jest.fn<any>(),
      },
      transactionTag: {
        createMany: jest.fn<any>(),
      },
      transactionAudit: {
        create: jest.fn<any>(),
      },
      savingsAllocation: {
        groupBy: jest.fn<any>().mockResolvedValue([]),
      },
      $queryRaw: jest.fn<any>(),
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  describe('resolveClientTxId', () => {
    it('menggunakan client_tx_id dari body jika valid', () => {
      const result = resolveClientTxId(validUlid, undefined);
      expect(result).toBe(validUlid);
    });

    it('menggunakan Idempotency-Key dari header jika body tidak ada', () => {
      const result = resolveClientTxId(undefined, validUlid);
      expect(result).toBe(validUlid);
    });

    it('menggunakan elemen pertama jika header berupa array', () => {
      const result = resolveClientTxId(undefined, [validUlid, 'other']);
      expect(result).toBe(validUlid);
    });

    it('melempar 422 MISSING_CLIENT_TX_ID jika keduanya tidak ada atau string kosong', () => {
      expect(() => resolveClientTxId(undefined, undefined)).toThrow(
        UnprocessableEntityException,
      );
      try {
        resolveClientTxId('  ', '  ');
      } catch (err: any) {
        expect(err.getResponse().code).toBe('MISSING_CLIENT_TX_ID');
      }
    });

    it('melempar 422 VALIDATION_ERROR jika format bukan ULID valid', () => {
      expect(() => resolveClientTxId('invalid-ulid', undefined)).toThrow(
        UnprocessableEntityException,
      );
      try {
        resolveClientTxId(undefined, 'not-a-valid-ulid');
      } catch (err: any) {
        expect(err.getResponse().code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('toTransactionResponse', () => {
    it('mengonversi BigInt ke number dan memformat date YYYY-MM-DD', () => {
      const record = {
        id: 'tx-1',
        financial_profile_id: 'prof-1',
        user_id: 'user-1',
        account_id: 'acc-1',
        type: 'INCOME',
        amount: 50000n,
        date: new Date('2026-11-05T00:00:00.000Z'),
        status: 'POSTED',
        category_id: 'cat-1',
        client_tx_id: validUlid,
        transfer_fee: 0n,
        tags: [{ tag_id: 'tag-1' }, 'tag-2'],
        created_at: new Date('2026-11-05T04:00:00.000Z'),
        updated_at: new Date('2026-11-05T04:00:00.000Z'),
      };

      const res = toTransactionResponse(record, 'NEGATIVE_BALANCE');
      expect(res.amount).toBe(50000);
      expect(typeof res.amount).toBe('number');
      expect(res.date).toBe('2026-11-05');
      expect(res.tags).toEqual(['tag-1', 'tag-2']);
      expect(res.warning).toBe('NEGATIVE_BALANCE');
    });
  });

  describe('createIncome', () => {
    it('AC-1 & AC-2: berhasil membuat income posted, saldo bertambah, audit log tercatat', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue(mockCategory);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-123',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'INCOME' as const,
        amount: 25000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01', // date <= today -> POSTED
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('POSTED');
      expect(result.amount).toBe(25000);
      expect(typeof result.amount).toBe('number');

      // Update saldo akun
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockAccount.id, user_id: user.userId },
        data: { balance: 125000n },
      });

      // Audit log tercatat
      expect(prisma.transactionAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transaction_id: 'tx-123',
            action: 'CREATE',
            before: Prisma.DbNull,
            actor_user_id: user.userId,
            after: expect.objectContaining({
              amount: 25000,
            }),
          }),
        }),
      );
    });

    it('AC-3: transaksi date > today berstatus SCHEDULED dan saldo akun TIDAK berubah', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue(mockCategory);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-scheduled',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'INCOME' as const,
        amount: 50000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2099-12-31', // Future date -> SCHEDULED
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('SCHEDULED');
      expect(prisma.account.update).not.toHaveBeenCalled();
    });

    it('memberikan warning NEGATIVE_BALANCE jika saldo setelah POSTED masih < 0', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          ...mockAccount,
          balance: -100000n,
          allow_negative: true,
        },
      ]);
      prisma.category.findFirst.mockResolvedValue(mockCategory);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-neg',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'INCOME' as const,
        amount: 20000, // saldo akhir -80000n (< 0n)
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);
      expect(result.warning).toBe('NEGATIVE_BALANCE');
    });

    it('AC-4: melempar 404 jika akun tidak ditemukan', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const dto = {
        type: 'INCOME' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('AC-4: melempar 409 jika akun diarsipkan', async () => {
      prisma.$queryRaw.mockResolvedValue([{ ...mockAccount, archived: true }]);

      const dto = {
        type: 'INCOME' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('AC-4: melempar 404 jika kategori tidak ditemukan', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue(null);

      const dto = {
        type: 'INCOME' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('AC-4: melempar 422 CATEGORY_ARCHIVED jika kategori diarsipkan', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue({
        ...mockCategory,
        archived: true,
      });

      const dto = {
        type: 'INCOME' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('AC-4: melempar 400 INVALID_CATEGORY_TYPE jika kategori bukan bertipe INCOME', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue({
        ...mockCategory,
        type: 'EXPENSE',
      });

      const dto = {
        type: 'INCOME' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('melempar 404 TAG_NOT_FOUND jika tag tidak ditemukan', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue(mockCategory);
      prisma.tag.findMany.mockResolvedValue([]); // Kosong

      const dto = {
        type: 'INCOME' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        tags: ['55555555-5555-5555-5555-555555555555'],
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('melempar 422 TAG_ARCHIVED jika tag telah diarsipkan', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue(mockCategory);
      prisma.tag.findMany.mockResolvedValue([
        { id: '55555555-5555-5555-5555-555555555555', archived: true },
      ]);

      const dto = {
        type: 'INCOME' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        tags: ['55555555-5555-5555-5555-555555555555'],
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('berhasil menyimpan relasi tag jika tag valid', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue(mockCategory);
      prisma.tag.findMany.mockResolvedValue([
        { id: '55555555-5555-5555-5555-555555555555', archived: false },
      ]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-with-tags',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'INCOME' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        tags: ['55555555-5555-5555-5555-555555555555'],
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);
      expect(result.tags).toEqual(['55555555-5555-5555-5555-555555555555']);
      expect(prisma.transactionTag.createMany).toHaveBeenCalledWith({
        data: [
          {
            transaction_id: 'tx-with-tags',
            tag_id: '55555555-5555-5555-5555-555555555555',
          },
        ],
      });
    });

    it('melempar 409 CLIENT_TX_ID_DUPLICATE jika client_tx_id sudah dipakai', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue(mockCategory);
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint violation',
        { code: 'P2002', clientVersion: '5.0.0' },
      );
      prisma.transaction.create.mockRejectedValue(p2002Error);

      const dto = {
        type: 'INCOME' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: mockCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('getAccountReserved', () => {
    it('mengembalikan jumlah amount aktif dari savings_allocations', async () => {
      prisma.savingsAllocation.groupBy.mockResolvedValue([
        { _sum: { amount: 75000n } },
      ]);
      const res = await getAccountReserved(prisma, 'acc-1');
      expect(res).toBe(75000n);
    });

    it('mengembalikan 0n jika tidak ada alokasi aktif', async () => {
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      const res = await getAccountReserved(prisma, 'acc-1');
      expect(res).toBe(0n);
    });
  });

  describe('createExpense', () => {
    const expenseCategory = {
      id: '55555555-5555-5555-5555-555555555555',
      type: 'EXPENSE',
      archived: false,
    };

    it('AC-1: berhasil membuat expense posted, saldo berkurang, audit log tercatat', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]); // balance: 100000n
      prisma.category.findFirst.mockResolvedValue(expenseCategory);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]); // reserved: 0n
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-exp-1',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'EXPENSE' as const,
        amount: 40000,
        account_id: mockAccount.id,
        category_id: expenseCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('POSTED');
      expect(result.amount).toBe(40000);
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockAccount.id, user_id: user.userId },
        data: { balance: 60000n }, // 100000n - 40000n
      });

      expect(prisma.transactionAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transaction_id: 'tx-exp-1',
            action: 'CREATE',
            before: Prisma.DbNull,
          }),
        }),
      );
    });

    it('AC-2: tolak 409 INSUFFICIENT_BALANCE jika amount > available_balance (allow_negative = false)', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]); // balance: 100000n
      prisma.category.findFirst.mockResolvedValue(expenseCategory);
      prisma.savingsAllocation.groupBy.mockResolvedValue([
        { _sum: { amount: 70000n } }, // reserved: 70000n -> available: 30000n
      ]);

      const dto = {
        type: 'EXPENSE' as const,
        amount: 50000, // 50000 > available (30000)
        account_id: mockAccount.id,
        category_id: expenseCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        ConflictException,
      );

      try {
        await service.create(user, dto);
      } catch (err: any) {
        expect(err.getResponse()).toEqual({
          code: 'INSUFFICIENT_BALANCE',
          message: 'Saldo tersedia tidak mencukupi',
          details: {
            available: 30000,
            needed: 50000,
            account_id: mockAccount.id,
          },
        });
      }

      expect(prisma.account.update).not.toHaveBeenCalled();
    });

    it('AC-3: akun allow_negative = true berhasil dan menghasilkan warning NEGATIVE_BALANCE', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          ...mockAccount,
          balance: 30000n,
          allow_negative: true,
        },
      ]);
      prisma.category.findFirst.mockResolvedValue(expenseCategory);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-exp-neg',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'EXPENSE' as const,
        amount: 50000, // 30000 - 50000 = -20000 (< 0)
        account_id: mockAccount.id,
        category_id: expenseCategory.id,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('POSTED');
      expect(result.warning).toBe('NEGATIVE_BALANCE');
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockAccount.id, user_id: user.userId },
        data: { balance: -20000n },
      });
    });

    it('AC-4: tolak 400 INVALID_CATEGORY_TYPE jika kategori bertipe INCOME', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.category.findFirst.mockResolvedValue({
        id: 'cat-income',
        type: 'INCOME',
        archived: false,
      });

      const dto = {
        type: 'EXPENSE' as const,
        amount: 10000,
        account_id: mockAccount.id,
        category_id: 'cat-income',
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('AC-5: expense date > today berstatus SCHEDULED dan saldo akun TIDAK berubah meski saldo 0', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          ...mockAccount,
          balance: 0n,
          allow_negative: false,
        },
      ]);
      prisma.category.findFirst.mockResolvedValue(expenseCategory);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-exp-sched',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'EXPENSE' as const,
        amount: 50000,
        account_id: mockAccount.id,
        category_id: expenseCategory.id,
        date: '2099-12-31', // date > today
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('SCHEDULED');
      expect(prisma.account.update).not.toHaveBeenCalled();
    });
  });
});
