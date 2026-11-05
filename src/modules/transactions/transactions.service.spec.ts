import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
  ForbiddenException,
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
        findMany: jest.fn<any>(),
        update: jest.fn<any>(),
        create: jest.fn<any>(),
      },
      tag: {
        findMany: jest.fn<any>(),
      },
      account: {
        findFirst: jest.fn<any>(),
        findFirstOrThrow: jest.fn<any>(),
        update: jest.fn<any>(),
      },
      transaction: {
        create: jest.fn<any>(),
        update: jest.fn<any>(),
        findMany: jest.fn<any>(),
        findFirst: jest.fn<any>(),
      },
      transactionSplit: {
        findMany: jest.fn<any>().mockResolvedValue([]),
        deleteMany: jest.fn<any>(),
        createMany: jest.fn<any>(),
      },
      transactionTag: {
        findMany: jest.fn<any>().mockResolvedValue([]),
        deleteMany: jest.fn<any>(),
        createMany: jest.fn<any>(),
      },
      transactionAudit: {
        create: jest.fn<any>(),
      },
      fileAttachment: {
        findMany: jest.fn<any>().mockResolvedValue([]),
        deleteMany: jest.fn<any>(),
      },
      budgetPeriod: {
        findFirst: jest.fn<any>(),
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
          message:
            'Saldo akun tidak mencukupi. Sesuaikan saldo atau izinkan saldo negatif untuk akun ini.',
          details: {
            account_id: mockAccount.id,
            ledger_balance: 100000,
            reserved: 70000,
            available: 30000,
            needed: 50000,
            shortfall: 20000,
            resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
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

  describe('createTransfer', () => {
    const mockFromAccount = {
      id: '22222222-2222-2222-2222-222222222222',
      financial_profile_id: '33333333-3333-3333-3333-333333333333',
      balance: 1000000n,
      allow_negative: false,
      archived: false,
    };
    const mockToAccount = {
      id: '55555555-5555-5555-5555-555555555555',
      financial_profile_id: '33333333-3333-3333-3333-333333333333',
      balance: 0n,
      allow_negative: false,
      archived: false,
    };
    const mockFeeCategory = {
      id: '66666666-6666-6666-6666-666666666666',
      name: 'Biaya Transfer',
      type: 'EXPENSE',
      is_system: true,
      archived: false,
    };

    it('AC-1 (Metode A SEPARATE): transfer amount: 500000, fee: 6500, fee_mode: SEPARATE -> BCA 493500, GoPay 500000, 2 baris transaksi ber-transfer_group_id sama', async () => {
      prisma.$queryRaw.mockResolvedValue([mockFromAccount, mockToAccount]);
      prisma.category.findFirst.mockResolvedValue(mockFeeCategory);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);

      const createdTxs: any[] = [];
      prisma.transaction.create.mockImplementation((args: any) => {
        const item = {
          id: 'tx-' + (createdTxs.length + 1),
          ...args.data,
          created_at: new Date(),
          updated_at: new Date(),
        };
        createdTxs.push(item);
        return item;
      });

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 500000,
        fee: 6500,
        fee_mode: 'SEPARATE' as const,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('POSTED');
      expect(result.amount).toBe(500000);
      expect(result.transfer_fee).toBe(6500);
      expect(result.fee_mode).toBe('SEPARATE');
      expect(result.transfer_group_id).toBeDefined();

      // Memastikan 2 transaksi dibuat
      expect(createdTxs).toHaveLength(2);
      const [transferTx, expenseTx] = createdTxs;

      expect(transferTx.type).toBe('TRANSFER');
      expect(transferTx.amount).toBe(500000n);
      expect(transferTx.transfer_fee).toBe(6500n);
      expect(transferTx.fee_mode).toBe('SEPARATE');
      expect(transferTx.account_id).toBe(mockFromAccount.id);
      expect(transferTx.to_account_id).toBe(mockToAccount.id);

      expect(expenseTx.type).toBe('EXPENSE');
      expect(expenseTx.amount).toBe(6500n);
      expect(expenseTx.category_id).toBe(mockFeeCategory.id);
      expect(expenseTx.account_id).toBe(mockFromAccount.id);
      expect(expenseTx.to_account_id).toBeNull();
      expect(expenseTx.client_tx_id).toBe(`${validUlid}:fee`);
      expect(expenseTx.transfer_group_id).toBe(transferTx.transfer_group_id);

      // Memastikan saldo kedua akun diupdate dengan benar
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockFromAccount.id, user_id: user.userId },
        data: { balance: 493500n }, // 1000000 - (500000 + 6500)
      });
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockToAccount.id, user_id: user.userId },
        data: { balance: 500000n }, // 0 + 500000
      });

      // 2 audit log dibuat
      expect(prisma.transactionAudit.create).toHaveBeenCalledTimes(2);
    });

    it('AC-2 (Metode B BUNDLED): transfer amount: 500000, fee: 6500, fee_mode: BUNDLED -> BCA 500000, GoPay 493500, 1 baris TRANSFER tanpa EXPENSE', async () => {
      prisma.$queryRaw.mockResolvedValue([mockFromAccount, mockToAccount]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);

      const createdTxs: any[] = [];
      prisma.transaction.create.mockImplementation((args: any) => {
        const item = {
          id: 'tx-bundled',
          ...args.data,
          created_at: new Date(),
          updated_at: new Date(),
        };
        createdTxs.push(item);
        return item;
      });

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 500000,
        fee: 6500,
        fee_mode: 'BUNDLED' as const,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('POSTED');
      expect(result.amount).toBe(493500); // amountReceived
      expect(result.transfer_fee).toBe(6500);
      expect(result.fee_mode).toBe('BUNDLED');
      expect(result.transfer_group_id).toBeNull();

      expect(createdTxs).toHaveLength(1);
      expect(createdTxs[0].type).toBe('TRANSFER');
      expect(createdTxs[0].amount).toBe(493500n);
      expect(createdTxs[0].transfer_fee).toBe(6500n);
      expect(createdTxs[0].fee_mode).toBe('BUNDLED');
      expect(createdTxs[0].transfer_group_id).toBeNull();

      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockFromAccount.id, user_id: user.userId },
        data: { balance: 500000n }, // 1000000 - 500000
      });
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockToAccount.id, user_id: user.userId },
        data: { balance: 493500n }, // 0 + 493500
      });

      expect(prisma.transactionAudit.create).toHaveBeenCalledTimes(1);
    });

    it('AC-3: fee = 0 -> hanya 1 baris TRANSFER dibuat, fee_mode null, tanpa baris EXPENSE 0', async () => {
      prisma.$queryRaw.mockResolvedValue([mockFromAccount, mockToAccount]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);

      const createdTxs: any[] = [];
      prisma.transaction.create.mockImplementation((args: any) => {
        const item = {
          id: 'tx-no-fee',
          ...args.data,
          created_at: new Date(),
          updated_at: new Date(),
        };
        createdTxs.push(item);
        return item;
      });

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 500000,
        fee: 0,
        fee_mode: 'SEPARATE' as const,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('POSTED');
      expect(result.amount).toBe(500000);
      expect(result.transfer_fee).toBe(0);
      expect(result.fee_mode).toBeNull();
      expect(result.transfer_group_id).toBeNull();

      expect(createdTxs).toHaveLength(1);
      expect(createdTxs[0].type).toBe('TRANSFER');
      expect(createdTxs[0].amount).toBe(500000n);
      expect(createdTxs[0].transfer_fee).toBe(0n);
      expect(createdTxs[0].fee_mode).toBeNull();
      expect(createdTxs[0].transfer_group_id).toBeNull();

      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockFromAccount.id, user_id: user.userId },
        data: { balance: 500000n },
      });
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockToAccount.id, user_id: user.userId },
        data: { balance: 500000n },
      });

      expect(prisma.transactionAudit.create).toHaveBeenCalledTimes(1);
    });

    it('AC-4: account_id === to_account_id -> 422 SAME_ACCOUNT_TRANSFER', async () => {
      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockFromAccount.id,
        amount: 100000,
        fee: 0,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('AC-5: available akun sumber 100000, transfer amount: 95000, fee: 10000 (allow_negative = false) -> 409 INSUFFICIENT_BALANCE', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { ...mockFromAccount, balance: 100000n },
        mockToAccount,
      ]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 95000,
        fee: 10000,
        fee_mode: 'SEPARATE' as const,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.account.update).not.toHaveBeenCalled();
    });

    it('AC-6 (isolasi): transfer dari/ke akun milik user lain -> 404 ACCOUNT_NOT_FOUND', async () => {
      // Hanya 1 akun ditemukan (akun kedua milik user lain atau tidak ada)
      prisma.$queryRaw.mockResolvedValue([mockFromAccount]);

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: '99999999-9999-9999-9999-999999999999',
        amount: 50000,
        fee: 0,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('Tolak 409 ACCOUNT_ARCHIVED jika salah satu akun diarsipkan', async () => {
      prisma.$queryRaw.mockResolvedValue([
        mockFromAccount,
        { ...mockToAccount, archived: true },
      ]);

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 50000,
        fee: 0,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('Metode B BUNDLED: tolak 422 VALIDATION_ERROR jika amount <= fee', async () => {
      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 5000,
        fee: 6500, // 5000 - 6500 = -1500 <= 0
        fee_mode: 'BUNDLED' as const,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('Metode A SEPARATE: auto-unarchive kategori sistem Biaya Transfer jika terarsip', async () => {
      prisma.$queryRaw.mockResolvedValue([mockFromAccount, mockToAccount]);
      prisma.category.findFirst.mockResolvedValue({
        ...mockFeeCategory,
        archived: true,
      });
      prisma.category.update.mockResolvedValue({
        ...mockFeeCategory,
        archived: false,
      });
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-unarchive',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 50000,
        fee: 2500,
        fee_mode: 'SEPARATE' as const,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await service.create(user, dto);

      expect(prisma.category.update).toHaveBeenCalledWith({
        where: { id: mockFeeCategory.id },
        data: { archived: false, archived_at: null },
      });
    });

    it('Metode A SEPARATE: tolak 422 CATEGORY_ARCHIVED jika custom fee_category_id diarsipkan', async () => {
      prisma.$queryRaw.mockResolvedValue([mockFromAccount, mockToAccount]);
      prisma.category.findFirst.mockResolvedValue({
        id: 'custom-fee-cat',
        type: 'EXPENSE',
        archived: true,
      });

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 50000,
        fee: 2500,
        fee_mode: 'SEPARATE' as const,
        fee_category_id: 'custom-fee-cat',
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('Transfer date > today berstatus SCHEDULED dan saldo akun TIDAK berubah', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { ...mockFromAccount, balance: 0n },
        mockToAccount,
      ]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-sched',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 50000,
        fee: 0,
        date: '2099-12-31', // date > today
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('SCHEDULED');
      expect(prisma.account.update).not.toHaveBeenCalled();
    });

    it('Transfer akun allow_negative = true berhasil dan menghasilkan warning NEGATIVE_BALANCE jika saldo akhir < 0', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { ...mockFromAccount, balance: 30000n, allow_negative: true },
        mockToAccount,
      ]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-neg',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'TRANSFER' as const,
        account_id: mockFromAccount.id,
        to_account_id: mockToAccount.id,
        amount: 50000, // 30000 - 50000 = -20000 (< 0)
        fee: 0,
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.status).toBe('POSTED');
      expect(result.warning).toBe('NEGATIVE_BALANCE');
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockFromAccount.id, user_id: user.userId },
        data: { balance: -20000n },
      });
    });
  });

  describe('createAdjustment', () => {
    it('AC-1 & AC-2: berhasil membuat adjustment, saldo berkurang, audit log before/after tercatat', async () => {
      const mockAcc = {
        id: mockAccount.id,
        financial_profile_id: mockAccount.financial_profile_id,
        balance: 1000000n,
        allow_negative: false,
        archived: false,
      };
      prisma.$queryRaw.mockResolvedValue([mockAcc]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-adj-1',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAcc.id,
        amount: -50000,
        date: '2026-11-01',
        reason: 'Selisih hitung kas dompet',
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.amount).toBe(-50000);
      expect(result.status).toBe('POSTED');
      expect(result.category_id).toBeNull();
      expect(result.reason).toBe('Selisih hitung kas dompet');
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockAcc.id, user_id: user.userId },
        data: { balance: 950000n },
      });
      expect(prisma.transactionAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          transaction_id: 'tx-adj-1',
          action: 'CREATE',
          reason: 'Selisih hitung kas dompet',
          before: { account_balance: 1000000 },
          after: expect.objectContaining({
            account_balance: 950000,
            amount: -50000,
          }),
          actor_user_id: user.userId,
        }),
      });
    });

    it('berhasil membuat adjustment positif yang menambah saldo', async () => {
      const mockAcc = {
        id: mockAccount.id,
        financial_profile_id: mockAccount.financial_profile_id,
        balance: 1000000n,
        allow_negative: false,
        archived: false,
      };
      prisma.$queryRaw.mockResolvedValue([mockAcc]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-adj-pos',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAcc.id,
        amount: 50000,
        date: '2026-11-01',
        reason: 'Koreksi penambahan kas fisik',
        client_tx_id: validUlid,
      };

      const result = await service.createAdjustment(user, dto);

      expect(result.amount).toBe(50000);
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockAcc.id, user_id: user.userId },
        data: { balance: 1050000n },
      });
    });

    it('AC-3: melempar 422 REASON_TOO_SHORT jika reason kurang dari 10 karakter', async () => {
      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAccount.id,
        amount: -50000,
        date: '2026-11-01',
        reason: 'koreksi',
        client_tx_id: validUlid,
      };

      await expect(service.createAdjustment(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
      await expect(service.createAdjustment(user, dto)).rejects.toMatchObject({
        response: { code: 'REASON_TOO_SHORT' },
      });
    });

    it('AC-4: melempar 422 VALIDATION_ERROR jika amount = 0', async () => {
      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAccount.id,
        amount: 0,
        date: '2026-11-01',
        reason: 'Selisih hitung kas dompet',
        client_tx_id: validUlid,
      };

      await expect(service.createAdjustment(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
      await expect(service.createAdjustment(user, dto)).rejects.toMatchObject({
        response: { code: 'VALIDATION_ERROR' },
      });
    });

    it('AC-5: tolak 409 INSUFFICIENT_BALANCE jika newBalance < 0 pada allow_negative = false', async () => {
      const mockAcc = {
        id: mockAccount.id,
        financial_profile_id: mockAccount.financial_profile_id,
        balance: 100000n,
        allow_negative: false,
        archived: false,
      };
      prisma.$queryRaw.mockResolvedValue([mockAcc]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);

      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAcc.id,
        amount: -200000,
        date: '2026-11-01',
        reason: 'Penyesuaian kas hilang besar',
        client_tx_id: validUlid,
      };

      await expect(service.createAdjustment(user, dto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.createAdjustment(user, dto)).rejects.toMatchObject({
        response: {
          code: 'INSUFFICIENT_BALANCE',
          details: {
            available: 100000,
            needed: 200000,
            account_id: mockAcc.id,
          },
        },
      });
    });

    it('AC-5: allow_negative = true berhasil dan menghasilkan warning NEGATIVE_BALANCE jika newBalance < 0', async () => {
      const mockAcc = {
        id: mockAccount.id,
        financial_profile_id: mockAccount.financial_profile_id,
        balance: 100000n,
        allow_negative: true,
        archived: false,
      };
      prisma.$queryRaw.mockResolvedValue([mockAcc]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-adj-neg',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAcc.id,
        amount: -200000,
        date: '2026-11-01',
        reason: 'Penyesuaian kas minus diizinkan',
        client_tx_id: validUlid,
      };

      const result = await service.createAdjustment(user, dto);

      expect(result.status).toBe('POSTED');
      expect(result.warning).toBe('NEGATIVE_BALANCE');
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockAcc.id, user_id: user.userId },
        data: { balance: -100000n },
      });
    });

    it('AC-6: melempar 404 ACCOUNT_NOT_FOUND jika akun tidak ditemukan / milik user lain', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAccount.id,
        amount: -50000,
        date: '2026-11-01',
        reason: 'Selisih hitung kas dompet',
        client_tx_id: validUlid,
      };

      await expect(service.createAdjustment(user, dto)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.createAdjustment(user, dto)).rejects.toMatchObject({
        response: { code: 'ACCOUNT_NOT_FOUND' },
      });
    });

    it('melempar 409 ACCOUNT_ARCHIVED jika akun diarsipkan', async () => {
      prisma.$queryRaw.mockResolvedValue([{ ...mockAccount, archived: true }]);

      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAccount.id,
        amount: -50000,
        date: '2026-11-01',
        reason: 'Selisih hitung kas dompet',
        client_tx_id: validUlid,
      };

      await expect(service.createAdjustment(user, dto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.createAdjustment(user, dto)).rejects.toMatchObject({
        response: { code: 'ACCOUNT_ARCHIVED' },
      });
    });

    it('melempar 422 VALIDATION_ERROR jika date > today (koreksi aktual tidak boleh terjadwal)', async () => {
      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAccount.id,
        amount: -50000,
        date: '2099-12-31',
        reason: 'Selisih hitung kas dompet',
        client_tx_id: validUlid,
      };

      await expect(service.createAdjustment(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
      await expect(service.createAdjustment(user, dto)).rejects.toMatchObject({
        response: { code: 'VALIDATION_ERROR' },
      });
    });

    it('mendukung eksekusi dengan existingTx tanpa membuka nested transaction', async () => {
      const mockAcc = {
        id: mockAccount.id,
        financial_profile_id: mockAccount.financial_profile_id,
        balance: 1000000n,
        allow_negative: false,
        archived: false,
      };
      const mockTx: any = {
        userPreference: {
          findFirst: jest.fn<any>().mockResolvedValue({ timezone: 'Asia/Jakarta' }),
        },
        $queryRaw: jest.fn<any>().mockResolvedValue([mockAcc]),
        savingsAllocation: {
          groupBy: jest.fn<any>().mockResolvedValue([]),
        },
        transaction: {
          create: jest.fn<any>().mockImplementation((args: any) => ({
            id: 'tx-adj-tx',
            ...args.data,
            created_at: new Date(),
            updated_at: new Date(),
          })),
        },
        account: {
          update: jest.fn<any>(),
        },
        transactionAudit: {
          create: jest.fn<any>(),
        },
      };

      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAcc.id,
        amount: -50000,
        date: '2026-11-01',
        reason: 'Selisih hitung kas dompet',
        client_tx_id: validUlid,
      };

      const result = await service.createAdjustment(user, dto, mockTx);

      expect(result.id).toBe('tx-adj-tx');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(mockTx.account.update).toHaveBeenCalledWith({
        where: { id: mockAcc.id, user_id: user.userId },
        data: { balance: 950000n },
      });
    });

    it('melempar 409 CLIENT_TX_ID_DUPLICATE jika client_tx_id sudah dipakai', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '5.x' },
      );
      prisma.transaction.create.mockRejectedValue(p2002Error);

      const dto = {
        type: 'ADJUSTMENT' as const,
        account_id: mockAccount.id,
        amount: -50000,
        date: '2026-11-01',
        reason: 'Selisih hitung kas dompet',
        client_tx_id: validUlid,
      };

      await expect(service.createAdjustment(user, dto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.createAdjustment(user, dto)).rejects.toMatchObject({
        response: { code: 'CLIENT_TX_ID_DUPLICATE' },
      });
    });
  });

  describe('adjustToTarget (TASK-034)', () => {
    const fullMockAccount = {
      id: mockAccount.id,
      name: 'Kas Utama',
      type: 'CASH',
      provider: null,
      note: null,
      opening_balance: 1000000n,
      opening_date: new Date('2026-01-01'),
      balance: 1000000n,
      allow_negative: false,
      archived: false,
      archived_at: null,
      created_at: new Date('2026-01-01'),
    };

    it('berhasil menyesuaikan saldo ke saldo target dan memanggil createAdjustment', async () => {
      const mockAcc = {
        id: mockAccount.id,
        financial_profile_id: mockAccount.financial_profile_id,
        balance: 1000000n,
        allow_negative: false,
        archived: false,
      };
      prisma.$queryRaw.mockResolvedValue([mockAcc]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-adj-target-1',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));
      prisma.account.findFirstOrThrow.mockResolvedValue({
        ...fullMockAccount,
        balance: 950000n,
      });

      const res = await service.adjustToTarget(user, mockAccount.id, {
        target_balance: 950000,
        reason: 'Koreksi kas fisik',
        client_tx_id: validUlid,
      });

      expect(res.transaction_id).toBe('tx-adj-target-1');
      expect(res.amount).toBe(-50000);
      expect(res.account.balance).toBe(950000);
    });

    it('melempar 422 NO_BALANCE_CHANGE jika target_balance sama dengan saldo saat ini', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: mockAccount.id,
          financial_profile_id: mockAccount.financial_profile_id,
          balance: 1000000n,
          allow_negative: false,
          archived: false,
        },
      ]);

      await expect(
        service.adjustToTarget(user, mockAccount.id, {
          target_balance: 1000000,
          reason: 'Koreksi kas fisik',
          client_tx_id: validUlid,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('melempar 404 ACCOUNT_NOT_FOUND jika akun tidak ditemukan', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(
        service.adjustToTarget(user, mockAccount.id, {
          target_balance: 900000,
          reason: 'Koreksi kas fisik',
          client_tx_id: validUlid,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('melempar 409 ACCOUNT_ARCHIVED jika akun telah diarsipkan', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: mockAccount.id,
          financial_profile_id: mockAccount.financial_profile_id,
          balance: 1000000n,
          allow_negative: false,
          archived: true,
        },
      ]);

      await expect(
        service.adjustToTarget(user, mockAccount.id, {
          target_balance: 900000,
          reason: 'Koreksi kas fisik',
          client_tx_id: validUlid,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('melempar 409 NEGATIVE_BALANCE_NOT_ALLOWED jika target_balance < 0 dan allow_negative = false', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          id: mockAccount.id,
          financial_profile_id: mockAccount.financial_profile_id,
          balance: 100000n,
          allow_negative: false,
          archived: false,
        },
      ]);

      await expect(
        service.adjustToTarget(user, mockAccount.id, {
          target_balance: -50000,
          reason: 'Koreksi kas fisik minus',
          client_tx_id: validUlid,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Transaction Splits (TASK-044)', () => {
    const c1 = '44444444-4444-4444-4444-444444444441';
    const c2 = '44444444-4444-4444-4444-444444444442';
    const c3 = '44444444-4444-4444-4444-444444444443';

    it('AC-1: berhasil membuat expense dengan splits valid, 1 transaksi dan baris splits tersimpan', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.category.findMany.mockResolvedValue([
        { id: c1, user_id: user.userId, type: 'EXPENSE', archived: false },
        { id: c2, user_id: user.userId, type: 'EXPENSE', archived: false },
        { id: c3, user_id: user.userId, type: 'EXPENSE', archived: false },
      ]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-split-1',
        ...args.data,
        created_at: new Date(),
        updated_at: new Date(),
      }));

      const dto = {
        type: 'EXPENSE' as const,
        account_id: mockAccount.id,
        amount: 100000,
        splits: [
          { category_id: c1, amount: 40000 },
          { category_id: c2, amount: 35000 },
          { category_id: c3, amount: 25000 },
        ],
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      const result = await service.create(user, dto);

      expect(result.amount).toBe(100000);
      expect(result.category_id).toBeNull();
      expect(result.splits).toHaveLength(3);
      expect(prisma.transactionSplit.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ transaction_id: 'tx-split-1', category_id: c1, amount: 40000n }),
          expect.objectContaining({ transaction_id: 'tx-split-1', category_id: c2, amount: 35000n }),
          expect.objectContaining({ transaction_id: 'tx-split-1', category_id: c3, amount: 25000n }),
        ]),
      });
      // Saldo akun berkurang tepat 1 kali sebesar 100000
      expect(prisma.account.update).toHaveBeenCalledTimes(1);
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockAccount.id, user_id: user.userId },
        data: { balance: 0n },
      });
      // Audit log mencatat splits
      expect(prisma.transactionAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          transaction_id: 'tx-split-1',
          action: 'CREATE',
          after: expect.objectContaining({
            splits: expect.arrayContaining([
              expect.objectContaining({ category_id: c1, amount: 40000 }),
            ]),
          }),
        }),
      });
    });

    it('AC-2: melempar 422 SPLIT_SUM_MISMATCH jika jumlah nominal split != total amount', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);

      const dto = {
        type: 'EXPENSE' as const,
        account_id: mockAccount.id,
        amount: 100000,
        splits: [
          { category_id: c1, amount: 40000 },
          { category_id: c2, amount: 30000 }, // sum = 70000 != 100000
        ],
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
      await expect(service.create(user, dto)).rejects.toMatchObject({
        response: { code: 'SPLIT_SUM_MISMATCH' },
      });
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('AC-4: melempar 403 FORBIDDEN jika kategori split bukan milik user', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      // Hanya menemukan 1 dari 2 kategori
      prisma.category.findMany.mockResolvedValue([
        { id: c1, user_id: user.userId, type: 'EXPENSE', archived: false },
      ]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-forbidden',
        ...args.data,
      }));

      const dto = {
        type: 'EXPENSE' as const,
        account_id: mockAccount.id,
        amount: 100000,
        splits: [
          { category_id: c1, amount: 50000 },
          { category_id: c2, amount: 50000 },
        ],
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(ForbiddenException);
      await expect(service.create(user, dto)).rejects.toMatchObject({
        response: { code: 'FORBIDDEN' },
      });
    });

    it('AC-5: tolak 400 INVALID_CATEGORY_TYPE jika ada kategori bertipe salah', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.category.findMany.mockResolvedValue([
        { id: c1, user_id: user.userId, type: 'EXPENSE', archived: false },
        { id: c2, user_id: user.userId, type: 'INCOME', archived: false }, // salah tipe
      ]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-inv-type',
        ...args.data,
      }));

      const dto = {
        type: 'EXPENSE' as const,
        account_id: mockAccount.id,
        amount: 100000,
        splits: [
          { category_id: c1, amount: 50000 },
          { category_id: c2, amount: 50000 },
        ],
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(BadRequestException);
      await expect(service.create(user, dto)).rejects.toMatchObject({
        response: { code: 'INVALID_CATEGORY_TYPE' },
      });
    });

    it('AC-5: tolak 422 CATEGORY_ARCHIVED jika ada kategori yang diarsipkan', async () => {
      prisma.$queryRaw.mockResolvedValue([mockAccount]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.category.findMany.mockResolvedValue([
        { id: c1, user_id: user.userId, type: 'EXPENSE', archived: false },
        { id: c2, user_id: user.userId, type: 'EXPENSE', archived: true }, // diarsipkan
      ]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'tx-arch',
        ...args.data,
      }));

      const dto = {
        type: 'EXPENSE' as const,
        account_id: mockAccount.id,
        amount: 100000,
        splits: [
          { category_id: c1, amount: 50000 },
          { category_id: c2, amount: 50000 },
        ],
        date: '2026-11-01',
        client_tx_id: validUlid,
      };

      await expect(service.create(user, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );
      await expect(service.create(user, dto)).rejects.toMatchObject({
        response: { code: 'CATEGORY_ARCHIVED' },
      });
    });
  });

  describe('update (TASK-046)', () => {
    const existingTx = {
      id: 'tx-11111111-1111-1111-1111-111111111111',
      financial_profile_id: mockAccount.financial_profile_id,
      user_id: user.userId,
      account_id: mockAccount.id,
      to_account_id: null,
      type: 'EXPENSE',
      amount: 100000n,
      date: new Date('2026-11-01T00:00:00.000Z'),
      status: 'POSTED',
      category_id: mockCategory.id,
      transfer_group_id: null,
      transfer_fee: 0n,
      fee_mode: null,
      parent_transaction_id: null,
      reason: null,
      note: 'Catatan lama',
      client_tx_id: validUlid,
      processed_at: null,
      cancelled_at: null,
      created_at: new Date('2026-11-01T00:00:00.000Z'),
      updated_at: new Date('2026-11-01T00:00:00.000Z'),
    };

    it('AC-1: Transaksi POSTED EXPENSE 100000 (saldo akun 900000) -> edit amount 80000 -> saldo 920000, audit tersimpan', async () => {
      const accountBefore = { ...mockAccount, balance: 900000n };
      prisma.$queryRaw
        .mockResolvedValueOnce([existingTx])
        .mockResolvedValueOnce([accountBefore]);

      prisma.transactionSplit.findMany.mockResolvedValue([]);
      prisma.transactionTag.findMany.mockResolvedValue([]);
      prisma.budgetPeriod.findFirst.mockResolvedValue(null);

      prisma.transaction.update.mockImplementation((args: any) => ({
        ...existingTx,
        ...args.data,
      }));
      prisma.transactionAudit.create.mockResolvedValue({ id: 'audit-123' });

      const res = await service.update(user, existingTx.id, {
        amount: 80000,
        client_tx_id: '01ARZ3NDEKTSV4RRFFQ69G5FA9',
      });

      expect(res.transaction.amount).toBe(80000);
      expect(res.audit_id).toBe('audit-123');
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockAccount.id, user_id: user.userId },
        data: { balance: 920000n },
      });
      expect(prisma.transactionAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'UPDATE',
            before: expect.objectContaining({ amount: 100000 }),
            after: expect.objectContaining({ amount: 80000 }),
          }),
        }),
      );
    });

    it('AC-2: PATCH transaksi POSTED dengan account_id berbeda -> 422 ACCOUNT_CHANGE_NOT_ALLOWED', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([existingTx]);

      await expect(
        service.update(user, existingTx.id, {
          account_id: '99999999-9999-9999-9999-999999999999',
          client_tx_id: validUlid,
        }),
      ).rejects.toMatchObject({
        response: { code: 'ACCOUNT_CHANGE_NOT_ALLOWED' },
      });
    });

    it('AC-3: PATCH transaksi berstatus REVERSED -> 409 ALREADY_REVERSED', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ ...existingTx, status: 'REVERSED' }]);

      await expect(
        service.update(user, existingTx.id, {
          note: 'ubah catatan',
          client_tx_id: validUlid,
        }),
      ).rejects.toMatchObject({
        response: { code: 'ALREADY_REVERSED' },
      });
    });

    it('AC-4: Menaikkan amount EXPENSE melebihi available pada allow_negative=false -> 409 INSUFFICIENT_BALANCE', async () => {
      const accountBefore = { ...mockAccount, balance: 50000n, allow_negative: false };
      prisma.$queryRaw
        .mockResolvedValueOnce([existingTx])
        .mockResolvedValueOnce([accountBefore]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);

      await expect(
        service.update(user, existingTx.id, {
          amount: 200000,
          client_tx_id: validUlid,
        }),
      ).rejects.toMatchObject({
        response: { code: 'INSUFFICIENT_BALANCE' },
      });
    });

    it('AC-5: Edit note pada transaksi yang kategorinya telah diarsipkan tetap 200; ganti ke kategori arsip lain -> 422 CATEGORY_ARCHIVED', async () => {
      // 1. Edit note tanpa ganti kategori
      prisma.$queryRaw.mockResolvedValueOnce([existingTx]);
      prisma.transactionSplit.findMany.mockResolvedValue([]);
      prisma.transactionTag.findMany.mockResolvedValue([]);
      prisma.transaction.update.mockImplementation((args: any) => ({
        ...existingTx,
        ...args.data,
      }));
      prisma.transactionAudit.create.mockResolvedValue({ id: 'audit-note' });

      const res = await service.update(user, existingTx.id, {
        note: 'note baru',
        client_tx_id: validUlid,
      });
      expect(res.transaction.note).toBe('note baru');

      // 2. Ganti category_id ke kategori yang diarsipkan
      const archivedCatId = '88888888-8888-8888-8888-888888888888';
      prisma.$queryRaw.mockResolvedValueOnce([existingTx]);
      prisma.transactionSplit.findMany.mockResolvedValue([]);
      prisma.transactionTag.findMany.mockResolvedValue([]);
      prisma.category.findFirst.mockResolvedValue({
        id: archivedCatId,
        user_id: user.userId,
        archived: true,
        type: 'EXPENSE',
      });

      await expect(
        service.update(user, existingTx.id, {
          category_id: archivedCatId,
          client_tx_id: validUlid,
        }),
      ).rejects.toMatchObject({
        response: { code: 'CATEGORY_ARCHIVED' },
      });
    });

    it('AC-6 (isolasi): User B PATCH transaksi milik User A -> 404 TRANSACTION_NOT_FOUND', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(
        service.update({ userId: 'user-b-id' }, existingTx.id, {
          note: 'hacked',
          client_tx_id: validUlid,
        }),
      ).rejects.toMatchObject({
        response: { code: 'TRANSACTION_NOT_FOUND' },
      });
    });

    it('Peringatan periode budget terkunci jika EXPENSE diubah menyentuh locked period', async () => {
      const accountBefore = { ...mockAccount, balance: 900000n };
      prisma.$queryRaw
        .mockResolvedValueOnce([existingTx])
        .mockResolvedValueOnce([accountBefore]);
      prisma.transactionSplit.findMany.mockResolvedValue([]);
      prisma.transactionTag.findMany.mockResolvedValue([]);
      prisma.budgetPeriod.findFirst.mockResolvedValue({
        id: 'bp-locked',
        locked_at: new Date(),
      });
      prisma.transaction.update.mockImplementation((args: any) => ({
        ...existingTx,
        ...args.data,
      }));
      prisma.transactionAudit.create.mockResolvedValue({ id: 'audit-locked' });

      const res = await service.update(user, existingTx.id, {
        amount: 80000,
        client_tx_id: '01ARZ3NDEKTSV4RRFFQ69G5FA8',
      });

      expect(res.warning).toBe('LOCKED_BUDGET_PERIOD_AFFECTED');
      expect(res.transaction.warning).toBe('LOCKED_BUDGET_PERIOD_AFFECTED');
    });
  });

  describe('reverse (TASK-047)', () => {
    const originalExpense = {
      id: 'tx-22222222-2222-2222-2222-222222222222',
      financial_profile_id: mockAccount.financial_profile_id,
      user_id: user.userId,
      account_id: mockAccount.id,
      to_account_id: null,
      type: 'EXPENSE',
      amount: 100000n,
      date: new Date('2026-11-01T00:00:00.000Z'),
      status: 'POSTED',
      category_id: mockCategory.id,
      transfer_group_id: null,
      transfer_fee: 0n,
      fee_mode: null,
      parent_transaction_id: null,
      reason: null,
      note: 'Makan',
      client_tx_id: validUlid,
      processed_at: null,
      cancelled_at: null,
      created_at: new Date('2026-11-01T00:00:00.000Z'),
      updated_at: new Date('2026-11-01T00:00:00.000Z'),
    };

    it('AC-1: Expense POSTED 100000 (saldo akun 400000) -> reverse -> 201, status REVERSED, reversal dibuat, saldo kembali 500000', async () => {
      const accountBefore = { ...mockAccount, balance: 400000n };
      prisma.$queryRaw
        .mockResolvedValueOnce([originalExpense])
        .mockResolvedValueOnce([accountBefore]);
      prisma.transactionSplit.findMany.mockResolvedValue([]);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'reversal-tx-id',
        ...args.data,
        parent_transaction_id:
          args.data.parent_transaction_id ??
          args.data.parent?.connect?.id ??
          null,
        financial_profile_id: mockAccount.financial_profile_id,
        user_id: user.userId,
        account_id: mockAccount.id,
        to_account_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      }));
      prisma.transaction.update.mockResolvedValue({
        ...originalExpense,
        status: 'REVERSED',
      });
      prisma.transactionAudit.create.mockResolvedValue({ id: 'audit-rev' });

      const res = await service.reverse(user, originalExpense.id, {
        client_tx_id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      });

      expect(res.reversal_id).toBe('reversal-tx-id');
      expect(res.transaction.type).toBe('REVERSAL');
      expect(res.transaction.parent_transaction_id).toBe(originalExpense.id);
      expect(res.transaction.amount).toBe(100000);

      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: mockAccount.id, user_id: user.userId },
        data: { balance: 500000n },
      });
      expect(prisma.transaction.update).toHaveBeenCalledWith({
        where: { id: originalExpense.id, user_id: user.userId },
        data: { status: 'REVERSED' },
      });
    });

    it('AC-2: Memanggil reverse kedua kali pada transaksi REVERSED -> 409 ALREADY_REVERSED', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { ...originalExpense, status: 'REVERSED' },
      ]);

      await expect(
        service.reverse(user, originalExpense.id, {
          client_tx_id: validUlid,
        }),
      ).rejects.toMatchObject({
        response: { code: 'ALREADY_REVERSED' },
      });
    });

    it('AC-3: Reverse transaksi EXPENSE dengan 3 splits -> reversal memiliki 3 splits identik', async () => {
      const accountBefore = { ...mockAccount, balance: 400000n };
      const splitItems = [
        { id: 's1', transaction_id: originalExpense.id, category_id: 'c1', amount: 40000n },
        { id: 's2', transaction_id: originalExpense.id, category_id: 'c2', amount: 35000n },
        { id: 's3', transaction_id: originalExpense.id, category_id: 'c3', amount: 25000n },
      ];

      prisma.$queryRaw
        .mockResolvedValueOnce([originalExpense])
        .mockResolvedValueOnce([accountBefore]);
      prisma.transactionSplit.findMany.mockResolvedValue(splitItems);
      prisma.transaction.create.mockImplementation((args: any) => ({
        id: 'reversal-split-id',
        ...args.data,
        parent_transaction_id:
          args.data.parent_transaction_id ??
          args.data.parent?.connect?.id ??
          null,
        financial_profile_id: mockAccount.financial_profile_id,
        user_id: user.userId,
        account_id: mockAccount.id,
        created_at: new Date(),
        updated_at: new Date(),
      }));
      prisma.transaction.update.mockResolvedValue({
        ...originalExpense,
        status: 'REVERSED',
      });
      prisma.transactionAudit.create.mockResolvedValue({ id: 'audit-split-rev' });

      const res = await service.reverse(user, originalExpense.id, {
        client_tx_id: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      });

      expect(res.transaction.splits).toHaveLength(3);
      expect(prisma.transactionSplit.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ category_id: 'c1', amount: 40000n }),
            expect.objectContaining({ category_id: 'c2', amount: 35000n }),
            expect.objectContaining({ category_id: 'c3', amount: 25000n }),
          ]),
        }),
      );
    });

    it('AC-4: Reverse TRANSFER Metode A membalik TRANSFER dan EXPENSE fee secara atomic', async () => {
      const transferGroupId = 'group-111';
      const fromAcc = { ...mockAccount, id: 'acc-src', balance: 493500n };
      const toAcc = { ...mockAccount, id: 'acc-dst', balance: 500000n };

      const transferTx = {
        ...originalExpense,
        id: 'tx-transfer-id',
        type: 'TRANSFER',
        amount: 500000n,
        account_id: fromAcc.id,
        to_account_id: toAcc.id,
        transfer_group_id: transferGroupId,
        transfer_fee: 6500n,
        fee_mode: 'SEPARATE',
      };

      const feeTx = {
        ...originalExpense,
        id: 'tx-fee-id',
        type: 'EXPENSE',
        amount: 6500n,
        account_id: fromAcc.id,
        to_account_id: null,
        transfer_group_id: transferGroupId,
        transfer_fee: 0n,
        fee_mode: null,
      };

      prisma.$queryRaw
        .mockResolvedValueOnce([transferTx])
        .mockResolvedValueOnce([fromAcc, toAcc]);
      prisma.transactionSplit.findMany.mockResolvedValue([]);
      prisma.savingsAllocation.groupBy.mockResolvedValue([]);
      prisma.transaction.findMany.mockResolvedValue([transferTx, feeTx]);

      prisma.transaction.create
        .mockImplementationOnce((args: any) => ({
          id: 'rev-fee-id',
          ...args.data,
          parent_transaction_id:
            args.data.parent_transaction_id ??
            args.data.parent?.connect?.id ??
            null,
          financial_profile_id: mockAccount.financial_profile_id,
          user_id: user.userId,
          created_at: new Date(),
          updated_at: new Date(),
        }))
        .mockImplementationOnce((args: any) => ({
          id: 'rev-transfer-id',
          ...args.data,
          parent_transaction_id:
            args.data.parent_transaction_id ??
            args.data.parent?.connect?.id ??
            null,
          financial_profile_id: mockAccount.financial_profile_id,
          user_id: user.userId,
          created_at: new Date(),
          updated_at: new Date(),
        }));

      prisma.transaction.update.mockResolvedValue({});
      prisma.transactionAudit.create.mockResolvedValue({});

      const res = await service.reverse(user, transferTx.id, {
        client_tx_id: '01ARZ3NDEKTSV4RRFFQ69G5FA3',
      });

      expect(res.reversal_id).toBe('rev-transfer-id');
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: fromAcc.id, user_id: user.userId },
        data: { balance: 1000000n },
      });
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: toAcc.id, user_id: user.userId },
        data: { balance: 0n },
      });
    });

    it('AC-5: Memanggil /reverse pada transaksi SCHEDULED -> 409 CANNOT_REVERSE_SCHEDULED', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { ...originalExpense, status: 'SCHEDULED' },
      ]);

      await expect(
        service.reverse(user, originalExpense.id, {
          client_tx_id: validUlid,
        }),
      ).rejects.toMatchObject({
        response: { code: 'CANNOT_REVERSE_SCHEDULED' },
      });
    });

    it('AC-6 (isolasi): User B me-reverse transaksi User A -> 404 TRANSACTION_NOT_FOUND', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(
        service.reverse({ userId: 'other-user-id' }, originalExpense.id, {
          client_tx_id: validUlid,
        }),
      ).rejects.toMatchObject({
        response: { code: 'TRANSACTION_NOT_FOUND' },
      });
    });
  });

  describe('cancel (TASK-048)', () => {
    const scheduledExpense = {
      id: 'tx-scheduled-1111-1111-111111111111',
      financial_profile_id: mockAccount.financial_profile_id,
      user_id: user.userId,
      account_id: mockAccount.id,
      to_account_id: null,
      type: 'EXPENSE',
      amount: 50000n,
      date: new Date('2026-11-10T00:00:00.000Z'),
      status: 'SCHEDULED',
      category_id: mockCategory.id,
      transfer_group_id: null,
      transfer_fee: 0n,
      fee_mode: null,
      parent_transaction_id: null,
      reason: null,
      note: 'Belanja besok',
      client_tx_id: validUlid,
      processed_at: null,
      cancelled_at: null,
      created_at: new Date('2026-11-01T00:00:00.000Z'),
      updated_at: new Date('2026-11-01T00:00:00.000Z'),
    };

    it('AC-1: Transaksi EXPENSE status = SCHEDULED -> cancel -> 200 { id, status: CANCELLED, cancelled_at }, saldo tidak berubah, 1 audit CANCEL', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([scheduledExpense]);
      prisma.transaction.update.mockResolvedValueOnce({
        ...scheduledExpense,
        status: 'CANCELLED',
        cancelled_at: new Date(),
        reason: 'Batal beli',
      });
      prisma.transactionAudit.create.mockResolvedValueOnce({ id: 'audit-cancel-1' });

      const res = await service.cancel(
        user,
        scheduledExpense.id,
        { client_tx_id: validUlid, reason: 'Batal beli' },
      );

      expect(res.id).toBe(scheduledExpense.id);
      expect(res.status).toBe('CANCELLED');
      expect(res.cancelled_at).toBeInstanceOf(Date);

      // Verify no account balance changes
      expect(prisma.account.update).not.toHaveBeenCalled();

      // Verify transaction status updated
      expect(prisma.transaction.update).toHaveBeenCalledWith({
        where: { id: scheduledExpense.id, user_id: user.userId },
        data: {
          status: 'CANCELLED',
          cancelled_at: expect.any(Date),
          reason: 'Batal beli',
        },
      });

      // Verify TransactionAudit created
      expect(prisma.transactionAudit.create).toHaveBeenCalledWith({
        data: {
          transaction_id: scheduledExpense.id,
          action: 'CANCEL',
          before: { status: 'SCHEDULED' },
          after: { status: 'CANCELLED', cancelled_at: expect.any(Date) },
          actor_user_id: user.userId,
          reason: 'Batal beli',
        },
      });
    });

    it('AC-2: Memanggil cancel pada transaksi POSTED -> 409 NOT_SCHEDULED', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { ...scheduledExpense, status: 'POSTED' },
      ]);

      await expect(
        service.cancel(user, scheduledExpense.id, { client_tx_id: validUlid }),
      ).rejects.toMatchObject({
        response: { code: 'NOT_SCHEDULED' },
      });
    });

    it('AC-2: Memanggil cancel pada transaksi REVERSED -> 409 NOT_SCHEDULED', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { ...scheduledExpense, status: 'REVERSED' },
      ]);

      await expect(
        service.cancel(user, scheduledExpense.id, { client_tx_id: validUlid }),
      ).rejects.toMatchObject({
        response: { code: 'NOT_SCHEDULED' },
      });
    });

    it('AC-2: Memanggil cancel pada transaksi yang sudah CANCELLED -> 409 NOT_SCHEDULED', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { ...scheduledExpense, status: 'CANCELLED' },
      ]);

      await expect(
        service.cancel(user, scheduledExpense.id, { client_tx_id: validUlid }),
      ).rejects.toMatchObject({
        response: { code: 'NOT_SCHEDULED' },
      });
    });

    it('AC-3: Baris sedang dikunci (error 55P03) -> 409 RACE_CONDITION', async () => {
      const lockError = new Error('could not obtain lock on row in relation "transactions"');
      (lockError as any).code = '55P03';
      prisma.$queryRaw.mockRejectedValueOnce(lockError);

      await expect(
        service.cancel(user, scheduledExpense.id, { client_tx_id: validUlid }),
      ).rejects.toMatchObject({
        response: { code: 'RACE_CONDITION' },
      });
    });

    it('AC-4 (isolasi): User B membatalkan transaksi milik User A -> 404 TRANSACTION_NOT_FOUND', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(
        service.cancel(
          { userId: 'user-b-id' },
          scheduledExpense.id,
          { client_tx_id: validUlid },
        ),
      ).rejects.toMatchObject({
        response: { code: 'TRANSACTION_NOT_FOUND' },
      });
    });

    it('Batalkan scheduled transfer Metode A -> membatalkan TRANSFER dan EXPENSE fee atomic', async () => {
      const transferGroupId = 'group-scheduled-1111-1111-111111111111';
      const mainTransfer = {
        ...scheduledExpense,
        id: 'tx-transfer-main',
        type: 'TRANSFER',
        transfer_group_id: transferGroupId,
      };
      const feeExpense = {
        ...scheduledExpense,
        id: 'tx-fee-partner',
        type: 'EXPENSE',
        transfer_group_id: transferGroupId,
        reason: null,
      };

      prisma.$queryRaw
        .mockResolvedValueOnce([mainTransfer])
        .mockResolvedValueOnce([feeExpense]);

      prisma.transaction.update.mockResolvedValue({});
      prisma.transactionAudit.create.mockResolvedValue({});

      const res = await service.cancel(
        user,
        mainTransfer.id,
        { client_tx_id: validUlid, reason: 'Batal transfer' },
      );

      expect(res.id).toBe(mainTransfer.id);
      expect(res.status).toBe('CANCELLED');

      expect(prisma.transaction.update).toHaveBeenCalledWith({
        where: { id: mainTransfer.id, user_id: user.userId },
        data: {
          status: 'CANCELLED',
          cancelled_at: expect.any(Date),
          reason: 'Batal transfer',
        },
      });

      expect(prisma.transaction.update).toHaveBeenCalledWith({
        where: { id: feeExpense.id, user_id: user.userId },
        data: {
          status: 'CANCELLED',
          cancelled_at: expect.any(Date),
          reason: 'Batal transfer',
        },
      });

      expect(prisma.transactionAudit.create).toHaveBeenCalledTimes(2);
    });

    it('Melempar 422 MISSING_CLIENT_TX_ID jika client_tx_id dan header Idempotency-Key tidak disertakan', async () => {
      await expect(
        service.cancel(user, scheduledExpense.id, {} as any),
      ).rejects.toMatchObject({
        response: { code: 'MISSING_CLIENT_TX_ID' },
      });
    });
  });

  describe('LIST AND DETAIL TRANSACTIONS (TASK-053)', () => {
    const dummyDate = new Date('2026-01-15T00:00:00.000Z');
    const dummyCreated = new Date('2026-01-15T10:00:00.000Z');

    const sampleTx = {
      id: 'a0000000-0000-0000-0000-000000000001',
      financial_profile_id: 'p0000000-0000-0000-0000-000000000001',
      user_id: user.userId,
      account_id: mockAccount.id,
      to_account_id: null,
      type: 'EXPENSE',
      amount: 50000n,
      date: dummyDate,
      status: 'POSTED',
      category_id: mockCategory.id,
      transfer_group_id: null,
      transfer_fee: 0n,
      fee_mode: null,
      parent_transaction_id: null,
      reason: null,
      note: 'Makan siang enak',
      client_tx_id: validUlid,
      processed_at: null,
      cancelled_at: null,
      created_at: dummyCreated,
      updated_at: dummyCreated,
      category: {
        id: mockCategory.id,
        name: 'Makanan',
        icon: 'food',
        color: 'red',
      },
      splits: [],
      tags: [
        {
          tag: {
            id: 't0000000-0000-0000-0000-000000000001',
            name: 'Kuliah',
            color: 'blue',
            archived: false,
          },
        },
      ],
      attachments: [],
      audits: [],
    };

    it('AC-1: list mendukung limit dan cursor pagination', async () => {
      const tx2 = {
        ...sampleTx,
        id: 'a0000000-0000-0000-0000-000000000002',
        date: new Date('2026-01-14T00:00:00.000Z'),
      };
      const tx3 = {
        ...sampleTx,
        id: 'a0000000-0000-0000-0000-000000000003',
        date: new Date('2026-01-13T00:00:00.000Z'),
      };

      // Mock returning 3 items when take is 2 + 1 = 3
      prisma.transaction.findMany.mockResolvedValueOnce([sampleTx, tx2, tx3]);

      const res1 = await service.list(user.userId, {
        limit: 2,
        type: ['EXPENSE'],
        date_from: '2026-01-01',
        date_to: '2026-01-31',
      } as any);

      expect(res1.items.length).toBe(2);
      expect(res1.next_cursor).toBeTruthy();

      // Page 2 with cursor
      prisma.transaction.findMany.mockResolvedValueOnce([tx3]);

      const res2 = await service.list(user.userId, {
        limit: 2,
        cursor: res1.next_cursor!,
      } as any);

      expect(res2.items.length).toBe(1);
      expect(res2.next_cursor).toBeNull();
    });

    it('AC-2 & AC-3 & AC-4: list menyaring dengan filter q, status SCHEDULED, dan AND tag_id', async () => {
      prisma.transaction.findMany.mockResolvedValueOnce([
        {
          ...sampleTx,
          status: 'SCHEDULED',
        },
      ]);

      const res = await service.list(user.userId, {
        q: 'makan',
        status: ['SCHEDULED'],
        tag_id: [
          't0000000-0000-0000-0000-000000000001',
          't0000000-0000-0000-0000-000000000002',
        ],
      } as any);

      expect(res.items.length).toBe(1);
      expect(res.items[0].is_scheduled).toBe(true);

      const findManyCall = prisma.transaction.findMany.mock.calls[prisma.transaction.findMany.mock.calls.length - 1][0];
      expect(findManyCall.where.user_id).toBe(user.userId);
      expect(findManyCall.where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              { note: { contains: 'makan', mode: 'insensitive' } },
            ]),
          }),
          { status: { in: ['SCHEDULED'] } },
          { tags: { some: { tag_id: 't0000000-0000-0000-0000-000000000001' } } },
          { tags: { some: { tag_id: 't0000000-0000-0000-0000-000000000002' } } },
        ]),
      );
    });

    it('AC-5: decodeCursor yang gagal melempar 400 INVALID_CURSOR', async () => {
      await expect(
        service.list(user.userId, { cursor: 'bukan-cursor-valid' } as any),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_CURSOR' },
      });
    });

    it('AC-6: findOne mengembalikan transaction, splits, tags, attachments, audit', async () => {
      const fullTx = {
        ...sampleTx,
        splits: [
          {
            id: 's1',
            category_id: mockCategory.id,
            amount: 50000n,
            category: {
              id: mockCategory.id,
              name: 'Makanan',
              icon: 'food',
              color: 'red',
            },
          },
        ],
        attachments: [
          {
            id: 'att-1',
            transaction_id: sampleTx.id,
            storage_key: 'tx/sample.jpg',
            mime: 'image/jpeg',
            size_bytes: 12345n,
            uploaded_at: dummyCreated,
            uploaded_by: user.userId,
          },
        ],
        audits: [
          {
            id: 'aud-1',
            transaction_id: sampleTx.id,
            action: 'CREATE',
            before: null,
            after: {},
            actor_user_id: user.userId,
            reason: null,
            created_at: dummyCreated,
          },
        ],
      };

      prisma.transaction.findFirst.mockResolvedValueOnce(fullTx);

      const res = await service.findOne(user.userId, sampleTx.id);

      expect(res.transaction.id).toBe(sampleTx.id);
      expect(res.transaction.amount).toBe(50000);
      expect(res.splits.length).toBe(1);
      expect(res.splits[0].amount).toBe(50000);
      expect(res.tags.length).toBe(1);
      expect(res.attachments.length).toBe(1);
      expect(res.attachments[0].size_bytes).toBe(12345);
      expect(res.audit.length).toBe(1);
    });

    it('AC-6 (isolasi): findOne jika milik user lain atau tidak ada melempar 404 TRANSACTION_NOT_FOUND', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.findOne(user.userId, '00000000-0000-0000-0000-000000000099'),
      ).rejects.toMatchObject({
        response: { code: 'TRANSACTION_NOT_FOUND' },
      });
    });
  });
});
