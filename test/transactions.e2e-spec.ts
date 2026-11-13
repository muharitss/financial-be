import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { ScheduledTransactionService } from '../src/modules/transactions/scheduled-transaction.service.js';

function generateTestUlid(): string {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let str = '0';
  for (let i = 1; i < 26; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}

describe('Transactions E2E Test Suite (Supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let throttlerStorage: any;
  let scheduledService: ScheduledTransactionService;

  let userAHeaders: { cookie: string };
  let userBHeaders: { cookie: string };
  let userAId: string;
  let userBId: string;
  let profileAId: string;

  let userAAccount: any;
  let userBAccount: any;
  let incomeCategoryA: any;
  let expenseCategoryA: any;
  let userATag: any;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    throttlerStorage = app.get(ThrottlerStorage);
    scheduledService = app.get(ScheduledTransactionService);

    // Bersihkan test data lama
    await prisma.asSystem().idempotencyKey.deleteMany();
    await prisma.asSystem().transactionAudit.deleteMany();
    await prisma.asSystem().transactionTag.deleteMany();
    await prisma.asSystem().transaction.deleteMany();
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.asSystem().tag.deleteMany();
    await prisma.asSystem().account.deleteMany();
    await prisma.asSystem().category.deleteMany();
    await prisma.asSystem().user.deleteMany({
      where: {
        email: {
          endsWith: '@duitku.test',
        },
      },
    });

    // Registrasi User A
    const resA = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-a-trx@duitku.test',
        password: 'Password123!',
        name: 'User A Trx',
      });
    expect(resA.status).toBe(201);
    userAId = resA.body.user.id;
    const cookieA = resA.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userAHeaders = { cookie: cookieA };

    // Registrasi User B
    const resB = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-b-trx@duitku.test',
        password: 'Password123!',
        name: 'User B Trx',
      });
    expect(resB.status).toBe(201);
    userBId = resB.body.user.id;
    const cookieB = resB.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userBHeaders = { cookie: cookieB };

    // Ambil default profile User A
    const profileA = await prisma.financialProfile.findFirst({
      where: { user_id: userAId, is_default: true },
    });
    profileAId = profileA!.id;

    // Buat Akun User A
    const accResA = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'BCA User A',
        type: 'BANK',
        opening_balance: 1000000,
      });
    expect(accResA.status).toBe(201);
    userAAccount = accResA.body;

    // Buat Akun User B
    const accResB = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userBHeaders.cookie)
      .send({
        name: 'Mandiri User B',
        type: 'BANK',
        opening_balance: 500000,
      });
    expect(accResB.status).toBe(201);
    userBAccount = accResB.body;

    // Ambil kategori default User A
    incomeCategoryA = await prisma.category.findFirst({
      where: {
        user_id: userAId,
        type: 'INCOME',
        archived: false,
      },
    });
    expect(incomeCategoryA).toBeDefined();

    expenseCategoryA = await prisma.category.findFirst({
      where: {
        user_id: userAId,
        type: 'EXPENSE',
        archived: false,
      },
    });
    expect(expenseCategoryA).toBeDefined();

    // Buat Tag untuk User A
    userATag = await prisma.tag.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Bonus Tahunan',
      },
    });
  });

  beforeEach(() => {
    throttlerStorage?._storage?.clear();
    throttlerStorage?.hitExpirations?.clear();
  });

  afterAll(async () => {
    await prisma.asSystem().transactionAudit.deleteMany();
    await prisma.asSystem().transactionTag.deleteMany();
    await prisma.asSystem().transaction.deleteMany();
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.asSystem().tag.deleteMany();
    await prisma.asSystem().account.deleteMany();
    await prisma.asSystem().category.deleteMany();
    await prisma.asSystem().user.deleteMany({
      where: {
        email: {
          endsWith: '@duitku.test',
        },
      },
    });
    await app.close();
  });

  it('AC-1: POST /transactions (type: INCOME, date <= today) valid -> 201, status: POSTED, saldo bertambah, response tipe number', async () => {
    const clientTxId = generateTestUlid();
    const res = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 250000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        note: 'Gaji sampingan',
        client_tx_id: clientTxId,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('POSTED');
    expect(res.body.amount).toBe(250000);
    expect(typeof res.body.amount).toBe('number');
    expect(typeof res.body.transfer_fee).toBe('number');
    expect(res.body.date).toBe('2026-11-01');
    expect(res.body.client_tx_id).toBe(clientTxId);
    expect(res.body.warning).toBeUndefined();

    // Verifikasi saldo akun di database bertambah: 1000000 + 250000 = 1250000
    const updatedAcc = await prisma.account.findFirst({
      where: { id: userAAccount.id, user_id: userAId },
    });
    expect(updatedAcc?.balance).toBe(1250000n);
  });

  it('AC-2: Setelah AC-1, tercatat 1 baris transaction_audits dengan action = CREATE, before = null, after.amount = amount', async () => {
    const clientTxId = generateTestUlid();
    const res = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 150000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        client_tx_id: clientTxId,
      });

    expect(res.status).toBe(201);
    const txId = res.body.id;

    const audits = await prisma.asSystem().transactionAudit.findMany({
      where: { transaction_id: txId },
    });
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    expect(audit.action).toBe('CREATE');
    expect(audit.before).toBeNull();
    expect(audit.actor_user_id).toBe(userAId);

    const afterData = audit.after as any;
    expect(afterData).toBeDefined();
    expect(afterData.amount).toBe(150000);
    expect(typeof afterData.amount).toBe('number');
  });

  it('AC-3: POST /transactions (type: INCOME) dengan date > today -> 201, status: SCHEDULED, saldo tidak berubah', async () => {
    // Cek saldo awal akun User A sebelum SCHEDULED
    const accBefore = await prisma.account.findFirst({
      where: { id: userAAccount.id, user_id: userAId },
    });
    const balanceBefore = accBefore?.balance;

    const clientTxId = generateTestUlid();
    const res = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 500000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2099-12-31',
        client_tx_id: clientTxId,
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SCHEDULED');

    // Cek saldo akun di database TIDAK berubah
    const accAfter = await prisma.account.findFirst({
      where: { id: userAAccount.id, user_id: userAId },
    });
    expect(accAfter?.balance).toBe(balanceBefore);
  });

  it('AC-4: category_id bertipe EXPENSE -> 400 INVALID_CATEGORY_TYPE; kategori arsip -> 422 CATEGORY_ARCHIVED; akun arsip -> 409 ACCOUNT_ARCHIVED', async () => {
    // 1. Kategori EXPENSE
    const resExpense = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 50000,
        account_id: userAAccount.id,
        category_id: expenseCategoryA.id,
        date: '2026-11-01',
        client_tx_id: generateTestUlid(),
      });
    expect(resExpense.status).toBe(400);
    expect(resExpense.body.code).toBe('INVALID_CATEGORY_TYPE');

    // 2. Kategori diarsipkan
    const archivedCategory = await prisma.category.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Arsip Kategori Income ' + Date.now(),
        type: 'INCOME',
        archived: true,
      },
    });

    const resArchivedCat = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 50000,
        account_id: userAAccount.id,
        category_id: archivedCategory.id,
        date: '2026-11-01',
        client_tx_id: generateTestUlid(),
      });
    expect(resArchivedCat.status).toBe(422);
    expect(resArchivedCat.body.code).toBe('CATEGORY_ARCHIVED');

    // 3. Akun diarsipkan
    const archivedAcc = await prisma.account.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Akun Arsip ' + Date.now(),
        type: 'BANK',
        opening_balance: 0n,
        opening_date: new Date('2026-11-01T00:00:00.000Z'),
        balance: 0n,
        archived: true,
      },
    });

    const resArchivedAcc = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 50000,
        account_id: archivedAcc.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        client_tx_id: generateTestUlid(),
      });
    expect(resArchivedAcc.status).toBe(409);
    expect(resArchivedAcc.body.code).toBe('ACCOUNT_ARCHIVED');
  });

  it('AC-5: amount <= 0 atau desimal -> 400/422 VALIDATION_ERROR; tanpa client_tx_id & tanpa header -> 422 MISSING_CLIENT_TX_ID', async () => {
    // 1. amount = 0
    const resZero = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 0,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        client_tx_id: generateTestUlid(),
      });
    expect([400, 422]).toContain(resZero.status);
    expect(resZero.body.code).toBe('VALIDATION_ERROR');

    // 2. amount negatif
    const resNeg = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: -1000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        client_tx_id: generateTestUlid(),
      });
    expect([400, 422]).toContain(resNeg.status);
    expect(resNeg.body.code).toBe('VALIDATION_ERROR');

    // 3. amount desimal
    const resDecimal = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 1500.5,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        client_tx_id: generateTestUlid(),
      });
    expect([400, 422]).toContain(resDecimal.status);
    expect(resDecimal.body.code).toBe('VALIDATION_ERROR');

    // 4. Tanpa client_tx_id di body dan tanpa header Idempotency-Key
    const resNoIdempotency = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 50000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
      });
    expect(resNoIdempotency.status).toBe(422);
    expect(resNoIdempotency.body.code).toBe('MISSING_CLIENT_TX_ID');
  });

  it('AC-6 (isolasi): Menggunakan account_id, category_id, atau tags milik user lain -> 404, saldo user lain tidak berubah', async () => {
    const userBBalanceBefore = (await prisma.account.findFirst({
      where: { id: userBAccount.id, user_id: userBId },
    }))?.balance;

    // 1. Akun milik User B dengan credential User A
    const resWrongAcc = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 100000,
        account_id: userBAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        client_tx_id: generateTestUlid(),
      });
    expect(resWrongAcc.status).toBe(404);
    expect(resWrongAcc.body.code).toBe('ACCOUNT_NOT_FOUND');

    // 2. Kategori milik User B
    const catB = await prisma.category.findFirst({
      where: { user_id: userBId, type: 'INCOME' },
    });
    const resWrongCat = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 100000,
        account_id: userAAccount.id,
        category_id: catB!.id,
        date: '2026-11-01',
        client_tx_id: generateTestUlid(),
      });
    expect(resWrongCat.status).toBe(404);
    expect(resWrongCat.body.code).toBe('CATEGORY_NOT_FOUND');

    // 3. Tag milik User B
    const profileB = await prisma.financialProfile.findFirst({
      where: { user_id: userBId, is_default: true },
    });
    const tagB = await prisma.tag.create({
      data: {
        user_id: userBId,
        financial_profile_id: profileB!.id,
        name: 'Tag User B',
      },
    });

    const resWrongTag = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 100000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        tags: [tagB.id],
        client_tx_id: generateTestUlid(),
      });
    expect(resWrongTag.status).toBe(404);
    expect(resWrongTag.body.code).toBe('TAG_NOT_FOUND');

    // Verifikasi saldo akun User B tidak berubah
    const userBBalanceAfter = (await prisma.account.findFirst({
      where: { id: userBAccount.id, user_id: userBId },
    }))?.balance;
    expect(userBBalanceAfter).toBe(userBBalanceBefore);
  });

  it('Dapat menggunakan header Idempotency-Key jika client_tx_id tidak ada di body', async () => {
    const ulidFromHeader = generateTestUlid();
    const res = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .set('Idempotency-Key', ulidFromHeader)
      .send({
        type: 'INCOME',
        amount: 80000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
      });

    expect(res.status).toBe(201);
    expect(res.body.client_tx_id).toBe(ulidFromHeader);
  });

  it('Dapat menyertakan tag valid dan relasi transaction_tags tersimpan', async () => {
    const res = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 60000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        tags: [userATag.id],
        client_tx_id: generateTestUlid(),
      });

    expect(res.status).toBe(201);
    expect(res.body.tags).toEqual([userATag.id]);

    const txTags = await prisma.asSystem().transactionTag.findMany({
      where: { transaction_id: res.body.id },
    });
    expect(txTags).toHaveLength(1);
    expect(txTags[0].tag_id).toBe(userATag.id);
  });

  it('Melempar 422 TOO_MANY_TAGS jika tag lebih dari 10', async () => {
    const fakeUuids = Array(11).fill('00000000-0000-0000-0000-000000000001');
    const res = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 50000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        tags: fakeUuids,
        client_tx_id: generateTestUlid(),
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TOO_MANY_TAGS');
  });

  it('Melempar 422 TAG_ARCHIVED jika ada tag yang diarsipkan', async () => {
    const archivedTag = await prisma.tag.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Tag Arsip ' + Date.now(),
        archived: true,
      },
    });

    const res = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 50000,
        account_id: userAAccount.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        tags: [archivedTag.id],
        client_tx_id: generateTestUlid(),
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TAG_ARCHIVED');
  });

  it('Menyertakan warning NEGATIVE_BALANCE jika saldo akhir masih < 0', async () => {
    // Buat akun allow_negative dengan saldo awal 0, lalu paksa saldo negatif lewat raw query
    const negAcc = await prisma.account.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Akun Negatif ' + Date.now(),
        type: 'BANK',
        opening_balance: 0n,
        opening_date: new Date('2026-11-01T00:00:00.000Z'),
        balance: -200000n,
        allow_negative: true,
      },
    });

    const res = await request(app.getHttpServer())
      .post('/transactions')
      .set('Cookie', userAHeaders.cookie)
      .send({
        type: 'INCOME',
        amount: 50000, // Saldo akhir = -150000 (< 0)
        account_id: negAcc.id,
        category_id: incomeCategoryA.id,
        date: '2026-11-01',
        client_tx_id: generateTestUlid(),
      });

    expect(res.status).toBe(201);
    expect(res.body.warning).toBe('NEGATIVE_BALANCE');
  });

  describe('EXPENSE Endpoints (TASK-041)', () => {
    it('AC-1: Akun balance = 100000, reserved = 0, allow_negative = false -> POST expense 40000 -> 201, status POSTED, balance 60000, 1 audit log', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Expense AC1 ' + Date.now(),
          type: 'BANK',
          opening_balance: 100000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 100000n,
          allow_negative: false,
        },
      });

      const clientTxId = generateTestUlid();
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          amount: 40000,
          account_id: acc.id,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
          client_tx_id: clientTxId,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('POSTED');
      expect(res.body.amount).toBe(40000);
      expect(res.body.client_tx_id).toBe(clientTxId);

      // Cek saldo akhir = 60000
      const updatedAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(updatedAcc?.balance).toBe(60000n);

      // Cek 1 baris TransactionAudit
      const audits = await prisma.asSystem().transactionAudit.findMany({
        where: { transaction_id: res.body.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('CREATE');
      expect(audits[0].before).toBeNull();
      expect((audits[0].after as any).amount).toBe(40000);
    });

    it('AC-2: Akun balance = 100000 dengan alokasi tabungan ACTIVE 70000 (available = 30000, allow_negative = false) -> POST expense 50000 -> 409 INSUFFICIENT_BALANCE', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Expense AC2 ' + Date.now(),
          type: 'BANK',
          opening_balance: 100000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 100000n,
          allow_negative: false,
        },
      });

      const goal = await prisma.savingsGoal.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Target Tabungan ' + Date.now(),
          target_amount: 500000n,
        },
      });

      await prisma.savingsAllocation.create({
        data: {
          savings_goal_id: goal.id,
          account_id: acc.id,
          amount: 70000n,
          status: 'ACTIVE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          amount: 50000,
          account_id: acc.id,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(res.body.details).toEqual({
        account_id: acc.id,
        ledger_balance: 100000,
        reserved: 70000,
        available: 30000,
        needed: 50000,
        shortfall: 20000,
        resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
      });

      // Saldo akun tidak berubah
      const unchangedAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(unchangedAcc?.balance).toBe(100000n);
    });

    it('AC-3: Akun balance = 30000, allow_negative = true -> POST expense 50000 -> 201 dengan warning NEGATIVE_BALANCE, balance menjadi -20000', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Expense AC3 ' + Date.now(),
          type: 'BANK',
          opening_balance: 30000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 30000n,
          allow_negative: true,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          amount: 50000,
          account_id: acc.id,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);
      expect(res.body.warning).toBe('NEGATIVE_BALANCE');

      const updatedAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(updatedAcc?.balance).toBe(-20000n);
    });

    it('AC-4: category_id bertipe INCOME -> 400 INVALID_CATEGORY_TYPE', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          amount: 50000,
          account_id: userAAccount.id,
          category_id: incomeCategoryA.id,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CATEGORY_TYPE');
    });

    it('AC-5: date > today pada akun bersaldo 0 (allow_negative = false) -> 201, status SCHEDULED, saldo tetap 0', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Expense AC5 ' + Date.now(),
          type: 'BANK',
          opening_balance: 0n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 0n,
          allow_negative: false,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          amount: 50000,
          account_id: acc.id,
          category_id: expenseCategoryA.id,
          date: '2099-12-31',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('SCHEDULED');

      const unchangedAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(unchangedAcc?.balance).toBe(0n);
    });

    it('AC-6 (isolasi): Expense menggunakan account_id atau category_id milik user lain -> 404', async () => {
      // 1. account milik User B
      const resAcc = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          amount: 10000,
          account_id: userBAccount.id,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });
      expect(resAcc.status).toBe(404);
      expect(resAcc.body.code).toBe('ACCOUNT_NOT_FOUND');

      // 2. category milik User B
      const catB = await prisma.category.findFirst({
        where: { user_id: userBId, type: 'EXPENSE' },
      });
      const resCat = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          amount: 10000,
          account_id: userAAccount.id,
          category_id: catB!.id,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });
      expect(resCat.status).toBe(404);
      expect(resCat.body.code).toBe('CATEGORY_NOT_FOUND');
    });
  });

  describe('TRANSFER Endpoints (TASK-042)', () => {
    it('AC-1 (Metode A SEPARATE): BCA 1000000, GoPay 0 -> transfer amount: 500000, fee: 6500, fee_mode: SEPARATE -> 201, BCA 493500, GoPay 500000, 2 baris transactions ber-transfer_group_id sama', async () => {
      const bca = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'BCA AC1 ' + Date.now(),
          type: 'BANK',
          opening_balance: 1000000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 1000000n,
          allow_negative: false,
        },
      });
      const gopay = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'GoPay AC1 ' + Date.now(),
          type: 'EWALLET',
          opening_balance: 0n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 0n,
          allow_negative: false,
        },
      });
      const clientTxId = generateTestUlid();

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TRANSFER',
          account_id: bca.id,
          to_account_id: gopay.id,
          amount: 500000,
          fee: 6500,
          fee_mode: 'SEPARATE',
          date: '2026-11-01',
          client_tx_id: clientTxId,
        });

      expect(res.status).toBe(201);
      expect(res.body.amount).toBe(500000);
      expect(res.body.transfer_fee).toBe(6500);
      expect(res.body.fee_mode).toBe('SEPARATE');
      expect(res.body.transfer_group_id).toBeTruthy();

      const bcaUpdated = await prisma.account.findFirst({ where: { id: bca.id, user_id: userAId } });
      const gopayUpdated = await prisma.account.findFirst({ where: { id: gopay.id, user_id: userAId } });
      expect(bcaUpdated?.balance).toBe(493500n);
      expect(gopayUpdated?.balance).toBe(500000n);

      const txs = await prisma.transaction.findMany({
        where: { transfer_group_id: res.body.transfer_group_id, user_id: userAId },
      });
      expect(txs).toHaveLength(2);

      const transferTx = txs.find((t) => t.type === 'TRANSFER');
      const expenseTx = txs.find((t) => t.type === 'EXPENSE');

      expect(transferTx).toBeDefined();
      expect(transferTx?.amount).toBe(500000n);
      expect(transferTx?.transfer_fee).toBe(6500n);
      expect(transferTx?.account_id).toBe(bca.id);
      expect(transferTx?.to_account_id).toBe(gopay.id);

      expect(expenseTx).toBeDefined();
      expect(expenseTx?.amount).toBe(6500n);
      expect(expenseTx?.account_id).toBe(bca.id);
      expect(expenseTx?.to_account_id).toBeNull();
      expect(expenseTx?.client_tx_id).toBe(`${clientTxId}:fee`);

      const cat = await prisma.category.findFirst({ where: { id: expenseTx?.category_id ?? '', user_id: userAId } });
      expect(cat?.name).toBe('Biaya Transfer');

      const audits = await prisma.asSystem().transactionAudit.findMany({
        where: { transaction_id: { in: [transferTx!.id, expenseTx!.id] } },
      });
      expect(audits).toHaveLength(2);
    });

    it('AC-2 (Metode B BUNDLED): BCA 1000000, GoPay 0 -> transfer amount: 500000, fee: 6500, fee_mode: BUNDLED -> 201, BCA 500000, GoPay 493500, hanya 1 baris TRANSFER tanpa EXPENSE', async () => {
      const bca = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'BCA AC2 ' + Date.now(),
          type: 'BANK',
          opening_balance: 1000000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 1000000n,
          allow_negative: false,
        },
      });
      const gopay = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'GoPay AC2 ' + Date.now(),
          type: 'EWALLET',
          opening_balance: 0n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 0n,
          allow_negative: false,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TRANSFER',
          account_id: bca.id,
          to_account_id: gopay.id,
          amount: 500000,
          fee: 6500,
          fee_mode: 'BUNDLED',
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);
      expect(res.body.amount).toBe(493500);
      expect(res.body.transfer_fee).toBe(6500);
      expect(res.body.fee_mode).toBe('BUNDLED');
      expect(res.body.transfer_group_id).toBeNull();

      const bcaUpdated = await prisma.account.findFirst({ where: { id: bca.id, user_id: userAId } });
      const gopayUpdated = await prisma.account.findFirst({ where: { id: gopay.id, user_id: userAId } });
      expect(bcaUpdated?.balance).toBe(500000n);
      expect(gopayUpdated?.balance).toBe(493500n);

      const tx = await prisma.transaction.findFirst({
        where: { id: res.body.id, user_id: userAId },
      });
      expect(tx?.amount).toBe(493500n);
      expect(tx?.transfer_fee).toBe(6500n);
      expect(tx?.fee_mode).toBe('BUNDLED');
      expect(tx?.transfer_group_id).toBeNull();

      const expenseTxs = await prisma.transaction.findMany({
        where: { account_id: bca.id, type: 'EXPENSE', user_id: userAId },
      });
      expect(expenseTxs).toHaveLength(0);

      const audits = await prisma.asSystem().transactionAudit.findMany({
        where: { transaction_id: res.body.id },
      });
      expect(audits).toHaveLength(1);
    });

    it('AC-3: fee = 0 -> hanya 1 baris TRANSFER dibuat, fee_mode null, tanpa baris EXPENSE 0', async () => {
      const bca = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'BCA AC3 ' + Date.now(),
          type: 'BANK',
          opening_balance: 1000000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 1000000n,
          allow_negative: false,
        },
      });
      const gopay = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'GoPay AC3 ' + Date.now(),
          type: 'EWALLET',
          opening_balance: 0n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 0n,
          allow_negative: false,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TRANSFER',
          account_id: bca.id,
          to_account_id: gopay.id,
          amount: 500000,
          fee: 0,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);
      expect(res.body.amount).toBe(500000);
      expect(res.body.transfer_fee).toBe(0);
      expect(res.body.fee_mode).toBeNull();
      expect(res.body.transfer_group_id).toBeNull();

      const bcaUpdated = await prisma.account.findFirst({ where: { id: bca.id, user_id: userAId } });
      const gopayUpdated = await prisma.account.findFirst({ where: { id: gopay.id, user_id: userAId } });
      expect(bcaUpdated?.balance).toBe(500000n);
      expect(gopayUpdated?.balance).toBe(500000n);

      const expenseTxs = await prisma.transaction.findMany({
        where: { account_id: bca.id, type: 'EXPENSE', user_id: userAId },
      });
      expect(expenseTxs).toHaveLength(0);
    });

    it('AC-4: account_id === to_account_id -> 422 SAME_ACCOUNT_TRANSFER', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TRANSFER',
          account_id: userAAccount.id,
          to_account_id: userAAccount.id,
          amount: 100000,
          fee: 0,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SAME_ACCOUNT_TRANSFER');
    });

    it('AC-5: available akun sumber 100000, transfer amount: 95000, fee: 10000 (allow_negative = false) -> 409 INSUFFICIENT_BALANCE, kedua saldo tidak berubah', async () => {
      const bca = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'BCA AC5 ' + Date.now(),
          type: 'BANK',
          opening_balance: 100000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 100000n,
          allow_negative: false,
        },
      });
      const gopay = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'GoPay AC5 ' + Date.now(),
          type: 'EWALLET',
          opening_balance: 0n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 0n,
          allow_negative: false,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TRANSFER',
          account_id: bca.id,
          to_account_id: gopay.id,
          amount: 95000,
          fee: 10000,
          fee_mode: 'SEPARATE',
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_BALANCE');

      const bcaAfter = await prisma.account.findFirst({ where: { id: bca.id, user_id: userAId } });
      const gopayAfter = await prisma.account.findFirst({ where: { id: gopay.id, user_id: userAId } });
      expect(bcaAfter?.balance).toBe(100000n);
      expect(gopayAfter?.balance).toBe(0n);
    });

    it('AC-6 (isolasi): transfer dari/ke akun milik user lain -> 404 ACCOUNT_NOT_FOUND', async () => {
      // 1. Akun tujuan milik user B
      const resToB = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TRANSFER',
          account_id: userAAccount.id,
          to_account_id: userBAccount.id,
          amount: 50000,
          fee: 0,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(resToB.status).toBe(404);
      expect(resToB.body.code).toBe('ACCOUNT_NOT_FOUND');

      // 2. Akun sumber milik user B
      const resFromB = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TRANSFER',
          account_id: userBAccount.id,
          to_account_id: userAAccount.id,
          amount: 50000,
          fee: 0,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(resFromB.status).toBe(404);
      expect(resFromB.body.code).toBe('ACCOUNT_NOT_FOUND');
    });

    it('Mendukung alias from_account_id sebagai pengganti account_id', async () => {
      const bca = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'BCA Alias ' + Date.now(),
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
          allow_negative: false,
        },
      });
      const gopay = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'GoPay Alias ' + Date.now(),
          type: 'EWALLET',
          opening_balance: 0n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 0n,
          allow_negative: false,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TRANSFER',
          from_account_id: bca.id,
          to_account_id: gopay.id,
          amount: 100000,
          fee: 0,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);
      expect(res.body.account_id).toBe(bca.id);
      expect(res.body.to_account_id).toBe(gopay.id);
    });

    it('Metode B BUNDLED: tolak 422 VALIDATION_ERROR jika amount <= fee', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TRANSFER',
          account_id: userAAccount.id,
          to_account_id: (await prisma.account.create({
            data: {
              user_id: userAId,
              financial_profile_id: profileAId,
              name: 'Dummy Dest ' + Date.now(),
              type: 'BANK',
              opening_balance: 0n,
              opening_date: new Date('2026-11-01T00:00:00.000Z'),
              balance: 0n,
            },
          })).id,
          amount: 5000,
          fee: 6500,
          fee_mode: 'BUNDLED',
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('ADJUSTMENT Endpoints (TASK-043)', () => {
    it('AC-1 & AC-2: Akun balance = 1000000 -> POST adjustment -50000 -> 201, balance = 950000, category_id = null, dan audit log tercatat', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Dompet Kas AC-1',
          type: 'CASH',
          opening_balance: 1000000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 1000000n,
        },
      });

      const clientTxId = generateTestUlid();
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'ADJUSTMENT',
          account_id: acc.id,
          amount: -50000,
          date: '2026-11-01',
          reason: 'Selisih hitung kas dompet',
          client_tx_id: clientTxId,
        });

      expect(res.status).toBe(201);
      expect(res.body.type).toBe('ADJUSTMENT');
      expect(res.body.amount).toBe(-50000);
      expect(res.body.category_id).toBeNull();
      expect(res.body.reason).toBe('Selisih hitung kas dompet');
      expect(res.body.status).toBe('POSTED');

      const updatedAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(updatedAcc!.balance).toBe(950000n);

      const audits = await prisma.asSystem().transactionAudit.findMany({
        where: { transaction_id: res.body.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('CREATE');
      expect(audits[0].reason).toBe('Selisih hitung kas dompet');
      expect(audits[0].before).toEqual({ account_balance: 1000000 });
      expect(audits[0].after).toMatchObject({
        account_balance: 950000,
        amount: -50000,
      });
    });

    it('AC-3: reason kurang dari 10 karakter ("koreksi") -> 422 REASON_TOO_SHORT', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'ADJUSTMENT',
          account_id: userAAccount.id,
          amount: -50000,
          date: '2026-11-01',
          reason: 'koreksi',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('REASON_TOO_SHORT');
    });

    it('AC-4: amount = 0 -> 400/422 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'ADJUSTMENT',
          account_id: userAAccount.id,
          amount: 0,
          date: '2026-11-01',
          reason: 'Penyesuaian nominal nol',
          client_tx_id: generateTestUlid(),
        });

      expect([400, 422]).toContain(res.status);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('AC-5: amount = -200000 pada akun balance = 100000, allow_negative = false -> 409 INSUFFICIENT_BALANCE', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Kas No Negative',
          type: 'CASH',
          opening_balance: 100000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 100000n,
          allow_negative: false,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'ADJUSTMENT',
          account_id: acc.id,
          amount: -200000,
          date: '2026-11-01',
          reason: 'Penyesuaian kas hilang besar',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(res.body.details).toEqual({
        account_id: acc.id,
        ledger_balance: 100000,
        reserved: 0,
        available: 100000,
        needed: 200000,
        shortfall: 100000,
        resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
      });

      const accAfter = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(accAfter!.balance).toBe(100000n);
    });

    it('AC-5: amount = -200000 pada akun balance = 100000, allow_negative = true -> 201 dengan warning NEGATIVE_BALANCE dan balance = -100000', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Kas Allow Negative',
          type: 'CASH',
          opening_balance: 100000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 100000n,
          allow_negative: true,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'ADJUSTMENT',
          account_id: acc.id,
          amount: -200000,
          date: '2026-11-01',
          reason: 'Penyesuaian kas negatif yang diizinkan',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);
      expect(res.body.warning).toBe('NEGATIVE_BALANCE');
      expect(res.body.amount).toBe(-200000);

      const accAfter = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(accAfter!.balance).toBe(-100000n);
    });

    it('AC-6 (isolasi): Adjustment pada account_id milik user lain -> 404 ACCOUNT_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'ADJUSTMENT',
          account_id: userBAccount.id,
          amount: -50000,
          date: '2026-11-01',
          reason: 'Mencoba adjust akun user lain',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');

      const userBAcc = await prisma.account.findFirst({
        where: { id: userBAccount.id, user_id: userBId },
      });
      expect(userBAcc!.balance).toBe(500000n);
    });

    it('Tolak 422 VALIDATION_ERROR jika date > today', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'ADJUSTMENT',
          account_id: userAAccount.id,
          amount: 50000,
          date: '2099-12-31',
          reason: 'Koreksi masa depan tidak valid',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('Dapat menggunakan header Idempotency-Key jika client_tx_id di body ditiadakan', async () => {
      const key = generateTestUlid();
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .set('Idempotency-Key', key)
        .send({
          type: 'ADJUSTMENT',
          account_id: userAAccount.id,
          amount: 10000,
          date: '2026-11-01',
          reason: 'Koreksi via Idempotency-Key header',
        });

      expect(res.status).toBe(201);
      expect(res.body.client_tx_id).toBe(key);
    });
  });

  describe('TRANSACTION SPLITS Endpoints (TASK-044)', () => {
    let catExp1: any;
    let catExp2: any;
    let catExp3: any;
    let catInc1: any;
    let catInc2: any;

    beforeAll(async () => {
      catExp1 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Split Makanan ' + Date.now(),
          type: 'EXPENSE',
        },
      });
      catExp2 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Split Perlengkapan ' + Date.now(),
          type: 'EXPENSE',
        },
      });
      catExp3 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Split Rumah ' + Date.now(),
          type: 'EXPENSE',
        },
      });
      catInc1 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Split Gaji ' + Date.now(),
          type: 'INCOME',
        },
      });
      catInc2 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Split Bonus ' + Date.now(),
          type: 'INCOME',
        },
      });
    });

    it('AC-1: POST expense dengan 3 splits -> 201, 1 transaksi, 3 splits di DB, saldo berkurang tepat 1x', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Split Test',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          account_id: acc.id,
          amount: 100000,
          splits: [
            { category_id: catExp1.id, amount: 40000 },
            { category_id: catExp2.id, amount: 35000 },
            { category_id: catExp3.id, amount: 25000 },
          ],
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);
      expect(res.body.amount).toBe(100000);
      expect(res.body.category_id).toBeNull();
      expect(res.body.splits).toHaveLength(3);

      const updatedAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(updatedAcc!.balance).toBe(400000n);

      const dbSplits = await prisma.asSystem().transactionSplit.findMany({
        where: { transaction_id: res.body.id },
      });
      expect(dbSplits).toHaveLength(3);
    });

    it('AC-2: Total splits != amount -> 422 SPLIT_SUM_MISMATCH', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          account_id: userAAccount.id,
          amount: 100000,
          splits: [
            { category_id: catExp1.id, amount: 40000 },
            { category_id: catExp2.id, amount: 30000 },
          ],
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SPLIT_SUM_MISMATCH');
    });

    it('AC-3: splits hanya 1 item -> 400/422 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          account_id: userAAccount.id,
          amount: 100000,
          splits: [{ category_id: catExp1.id, amount: 100000 }],
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect([400, 422]).toContain(res.status);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('AC-4: splits berisi category_id milik user lain -> 403 FORBIDDEN', async () => {
      // Buat kategori milik user B
      const userBProfile = await prisma.financialProfile.findFirst({ where: { user_id: userBId } });
      const catUserB = await prisma.category.create({
        data: {
          user_id: userBId,
          financial_profile_id: userBProfile!.id,
          name: 'Cat User B ' + Date.now(),
          type: 'EXPENSE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          account_id: userAAccount.id,
          amount: 100000,
          splits: [
            { category_id: catExp1.id, amount: 50000 },
            { category_id: catUserB.id, amount: 50000 },
          ],
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('AC-5: splits pada EXPENSE berisi kategori bertipe INCOME -> 400 INVALID_CATEGORY_TYPE; kategori arsip -> 422 CATEGORY_ARCHIVED', async () => {
      // 1. Kategori salah tipe (INCOME di EXPENSE)
      const resWrongType = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          account_id: userAAccount.id,
          amount: 100000,
          splits: [
            { category_id: catExp1.id, amount: 50000 },
            { category_id: catInc1.id, amount: 50000 },
          ],
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(resWrongType.status).toBe(400);
      expect(resWrongType.body.code).toBe('INVALID_CATEGORY_TYPE');

      // 2. Kategori diarsipkan
      const archivedCat = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Archived Split Cat ' + Date.now(),
          type: 'EXPENSE',
          archived: true,
          archived_at: new Date(),
        },
      });

      const resArchived = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'EXPENSE',
          account_id: userAAccount.id,
          amount: 100000,
          splits: [
            { category_id: catExp1.id, amount: 50000 },
            { category_id: archivedCat.id, amount: 50000 },
          ],
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(resArchived.status).toBe(422);
      expect(resArchived.body.code).toBe('CATEGORY_ARCHIVED');
    });

    it('mendukung splits pada transaksi bertipe INCOME', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'INCOME',
          account_id: userAAccount.id,
          amount: 200000,
          splits: [
            { category_id: catInc1.id, amount: 150000 },
            { category_id: catInc2.id, amount: 50000 },
          ],
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);
      expect(res.body.type).toBe('INCOME');
      expect(res.body.amount).toBe(200000);
      expect(res.body.category_id).toBeNull();
      expect(res.body.splits).toHaveLength(2);
    });
  });

  describe('SCHEDULED TRANSACTION POSTING (TASK-045)', () => {
    it('AC-1: Transaksi EXPENSE status = SCHEDULED dengan date <= today -> diposting -> status POSTED, balance berkurang, dan audit log tercatat', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Sched AC-1',
          type: 'BANK',
          opening_balance: 200000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 200000n,
        },
      });

      const schedTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const result = await scheduledService.processDueForUser(userAId);
      expect(result.processedCount).toBeGreaterThanOrEqual(1);

      const postedTx = await prisma.asSystem().transaction.findUnique({
        where: { id: schedTx.id },
      });
      expect(postedTx!.status).toBe('POSTED');
      expect(postedTx!.processed_at).not.toBeNull();
      expect(postedTx!.job_run_id).not.toBeNull();

      const updatedAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(updatedAcc!.balance).toBe(150000n);

      const audits = await prisma.asSystem().transactionAudit.findMany({
        where: { transaction_id: schedTx.id, action: 'UPDATE' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].reason).toBe('Auto-posted scheduled transaction');
      expect(audits[0].before).toMatchObject({ status: 'SCHEDULED' });
      expect(audits[0].after).toMatchObject({ status: 'POSTED' });
    });

    it('AC-2: Transaksi SCHEDULED dengan date > today tidak ikut diposting dan saldo akun tidak berubah', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Sched AC-2',
          type: 'BANK',
          opening_balance: 200000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 200000n,
        },
      });

      const futureTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2099-12-31T00:00:00.000Z'), // date > today
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      await scheduledService.processDueForUser(userAId);

      const checkTx = await prisma.asSystem().transaction.findUnique({
        where: { id: futureTx.id },
      });
      expect(checkTx!.status).toBe('SCHEDULED');
      expect(checkTx!.processed_at).toBeNull();

      const checkAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(checkAcc!.balance).toBe(200000n);
    });

    it('AC-3 (konkurensi / idempotensi): processDueForUser dan runDailyScheduledPosting bersamaan -> saldo berkurang tepat 1x', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Sched AC-3',
          type: 'BANK',
          opening_balance: 200000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 200000n,
        },
      });

      const schedTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 40000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      // Panggil bersamaan
      await Promise.all([
        scheduledService.processDueForUser(userAId),
        scheduledService.runDailyScheduledPosting(),
      ]);

      const checkAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(checkAcc!.balance).toBe(160000n); // 200000 - 40000, tepat 1x

      const checkTx = await prisma.asSystem().transaction.findUnique({
        where: { id: schedTx.id },
      });
      expect(checkTx!.status).toBe('POSTED');
    });

    it('AC-4: Saat user login (POST /auth/login), onLoginPostProcess memicu pemrosesan transaksi SCHEDULED', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Sched AC-4',
          type: 'BANK',
          opening_balance: 200000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 200000n,
        },
      });

      const schedTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 30000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      // Login User A
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'user-a-trx@duitku.test',
          password: 'Password123!',
        });

      expect(res.status).toBe(200);

      // Tunggu fire-and-forget selesai
      await new Promise((resolve) => setTimeout(resolve, 300));

      const checkTx = await prisma.asSystem().transaction.findUnique({
        where: { id: schedTx.id },
      });
      expect(checkTx!.status).toBe('POSTED');
      expect(checkTx!.processed_at).not.toBeNull();

      const checkAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(checkAcc!.balance).toBe(170000n);
    });
  });

  describe('EDIT TRANSACTION WITH AUDIT (TASK-046)', () => {
    it('AC-1: Transaksi POSTED EXPENSE 100000 (saldo akun 900000) -> PATCH amount 80000 -> 200, saldo 920000, audit tersimpan', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Edit AC-1',
          type: 'BANK',
          opening_balance: 1000000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 900000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 100000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const clientTxId = generateTestUlid();
      const res = await request(app.getHttpServer())
        .patch(`/transactions/${tx.id}`)
        .set(userAHeaders)
        .send({
          amount: 80000,
          client_tx_id: clientTxId,
        });

      expect(res.status).toBe(200);
      expect(res.body.transaction.amount).toBe(80000);
      expect(res.body.audit_id).toBeDefined();

      const updatedAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(updatedAcc!.balance).toBe(920000n);

      const audit = await prisma.asSystem().transactionAudit.findUnique({
        where: { id: res.body.audit_id },
      });
      expect(audit).not.toBeNull();
      expect(audit!.action).toBe('UPDATE');
      expect((audit!.before as any).amount).toBe(100000);
      expect((audit!.after as any).amount).toBe(80000);
    });

    it('AC-2: PATCH transaksi POSTED dengan account_id berbeda -> 422 ACCOUNT_CHANGE_NOT_ALLOWED', async () => {
      const acc1 = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Edit AC-2-1',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });
      const acc2 = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Edit AC-2-2',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc1.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .patch(`/transactions/${tx.id}`)
        .set(userAHeaders)
        .send({
          account_id: acc2.id,
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ACCOUNT_CHANGE_NOT_ALLOWED');
    });

    it('AC-3: PATCH transaksi berstatus REVERSED -> 409 ALREADY_REVERSED', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Edit AC-3',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'REVERSED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .patch(`/transactions/${tx.id}`)
        .set(userAHeaders)
        .send({
          note: 'ubah note',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ALREADY_REVERSED');
    });

    it('AC-4: Menaikkan amount EXPENSE melebihi available pada akun allow_negative = false -> 409 INSUFFICIENT_BALANCE', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Edit AC-4',
          type: 'BANK',
          opening_balance: 100000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 50000n,
          allow_negative: false,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .patch(`/transactions/${tx.id}`)
        .set(userAHeaders)
        .send({
          amount: 150000, // butuh tambahan 100000, tapi balance hanya 50000
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_BALANCE');

      const checkAcc = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(checkAcc!.balance).toBe(50000n);
    });

    it('AC-5: Edit note pada transaksi yang kategorinya telah diarsipkan tetap 200; mengganti category_id ke kategori arsip lain -> 422 CATEGORY_ARCHIVED', async () => {
      const catArchived1 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Kategori Arsip 1',
          type: 'EXPENSE',
          archived: true,
          archived_at: new Date(),
        },
      });

      const catArchived2 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Kategori Arsip 2',
          type: 'EXPENSE',
          archived: true,
          archived_at: new Date(),
        },
      });

      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Edit AC-5',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 30000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: catArchived1.id,
          client_tx_id: generateTestUlid(),
        },
      });

      // 1. Edit note saja pada transaksi dengan kategori arsip -> 200
      const res1 = await request(app.getHttpServer())
        .patch(`/transactions/${tx.id}`)
        .set(userAHeaders)
        .send({
          note: 'catatan update arsip',
          client_tx_id: generateTestUlid(),
        });

      expect(res1.status).toBe(200);
      expect(res1.body.transaction.note).toBe('catatan update arsip');

      // 2. Ganti ke kategori arsip lain -> 422 CATEGORY_ARCHIVED
      const res2 = await request(app.getHttpServer())
        .patch(`/transactions/${tx.id}`)
        .set(userAHeaders)
        .send({
          category_id: catArchived2.id,
          client_tx_id: generateTestUlid(),
        });

      expect(res2.status).toBe(422);
      expect(res2.body.code).toBe('CATEGORY_ARCHIVED');
    });

    it('AC-6 (isolasi): User B PATCH transaksi milik User A -> 404 TRANSACTION_NOT_FOUND', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Isolasi AC-6',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 25000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      // User B mencoba PATCH
      const res = await request(app.getHttpServer())
        .patch(`/transactions/${tx.id}`)
        .set(userBHeaders)
        .send({
          note: 'hacked by User B',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('Tolak 400 VALIDATION_ERROR jika tidak ada field perubahan, tolak 422 MISSING_CLIENT_TX_ID tanpa client_tx_id', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Val AC',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 20000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      // Tanpa field mutasi
      const res1 = await request(app.getHttpServer())
        .patch(`/transactions/${tx.id}`)
        .set(userAHeaders)
        .send({
          client_tx_id: generateTestUlid(),
        });
      expect(res1.status).toBe(400);

      // Tanpa client_tx_id
      const res2 = await request(app.getHttpServer())
        .patch(`/transactions/${tx.id}`)
        .set(userAHeaders)
        .send({
          note: 'note baru',
        });
      expect(res2.status).toBe(422);
      expect(res2.body.code).toBe('MISSING_CLIENT_TX_ID');
    });
  });

  describe('REVERSAL ENDPOINTS (TASK-047)', () => {
    it('AC-1: Expense POSTED 100000 (saldo akun 400000) -> POST /transactions/:id/reverse -> 201, transaksi asli REVERSED, reversal dibuat, saldo 500000', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Rev AC-1',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 400000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 100000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const clientTxId = generateTestUlid();
      const res = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/reverse`)
        .set(userAHeaders)
        .send({
          reason: 'Salah input nominal',
          client_tx_id: clientTxId,
        });

      expect(res.status).toBe(201);
      expect(res.body.reversal_id).toBeDefined();
      expect(res.body.transaction.type).toBe('REVERSAL');
      expect(res.body.transaction.parent_transaction_id).toBe(tx.id);
      expect(res.body.transaction.amount).toBe(100000);

      const originalCheck = await prisma.asSystem().transaction.findUnique({
        where: { id: tx.id },
      });
      expect(originalCheck!.status).toBe('REVERSED');

      const accCheck = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(accCheck!.balance).toBe(500000n);

      const audits = await prisma.asSystem().transactionAudit.findMany({
        where: { transaction_id: { in: [tx.id, res.body.reversal_id] } },
      });
      expect(audits).toHaveLength(2);
      const revAudit = audits.find((a) => a.action === 'REVERSE');
      const createAudit = audits.find((a) => a.action === 'CREATE');
      expect(revAudit).toBeDefined();
      expect(createAudit).toBeDefined();
    });

    it('AC-2: Memanggil POST /transactions/:id/reverse kedua kali pada transaksi yang sudah REVERSED -> 409 ALREADY_REVERSED', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Rev AC-2',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 400000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'REVERSED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/reverse`)
        .set(userAHeaders)
        .send({
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ALREADY_REVERSED');
    });

    it('AC-3: Reverse transaksi EXPENSE dengan 3 splits -> transaksi REVERSAL memiliki 3 splits identik', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Rev AC-3',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 400000n,
        },
      });

      const c1 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Split Rev C1',
          type: 'EXPENSE',
        },
      });
      const c2 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Split Rev C2',
          type: 'EXPENSE',
        },
      });
      const c3 = await prisma.category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Split Rev C3',
          type: 'EXPENSE',
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 100000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: null,
          client_tx_id: generateTestUlid(),
        },
      });

      await prisma.transactionSplit.createMany({
        data: [
          { transaction_id: tx.id, category_id: c1.id, amount: 40000n },
          { transaction_id: tx.id, category_id: c2.id, amount: 35000n },
          { transaction_id: tx.id, category_id: c3.id, amount: 25000n },
        ],
      });

      const res = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/reverse`)
        .set(userAHeaders)
        .send({
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);
      expect(res.body.transaction.splits).toHaveLength(3);

      const dbSplits = await prisma.transactionSplit.findMany({
        where: { transaction_id: res.body.reversal_id },
        orderBy: { amount: 'desc' },
      });
      expect(dbSplits).toHaveLength(3);
      expect(dbSplits[0].amount).toBe(40000n);
      expect(dbSplits[1].amount).toBe(35000n);
      expect(dbSplits[2].amount).toBe(25000n);
    });

    it('AC-4: Reverse TRANSFER Metode A membalik TRANSFER dan EXPENSE fee secara atomic', async () => {
      const fromAcc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Src Rev AC-4',
          type: 'BANK',
          opening_balance: 1000000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 493500n,
        },
      });
      const toAcc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Dst Rev AC-4',
          type: 'BANK',
          opening_balance: 0n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const transferGroupId = '00000000-0000-0000-0000-000000000042';

      const transferTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: fromAcc.id,
          to_account_id: toAcc.id,
          type: 'TRANSFER',
          amount: 500000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          transfer_group_id: transferGroupId,
          transfer_fee: 6500n,
          fee_mode: 'SEPARATE',
          client_tx_id: generateTestUlid(),
        },
      });

      const feeTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: fromAcc.id,
          type: 'EXPENSE',
          amount: 6500n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          transfer_group_id: transferGroupId,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/transactions/${transferTx.id}/reverse`)
        .set(userAHeaders)
        .send({
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(201);

      const updatedTransfer = await prisma.asSystem().transaction.findUnique({
        where: { id: transferTx.id },
      });
      const updatedFee = await prisma.asSystem().transaction.findUnique({
        where: { id: feeTx.id },
      });
      expect(updatedTransfer!.status).toBe('REVERSED');
      expect(updatedFee!.status).toBe('REVERSED');

      const fromCheck = await prisma.account.findFirst({
        where: { id: fromAcc.id, user_id: userAId },
      });
      const toCheck = await prisma.account.findFirst({
        where: { id: toAcc.id, user_id: userAId },
      });
      expect(fromCheck!.balance).toBe(1000000n);
      expect(toCheck!.balance).toBe(0n);
    });

    it('AC-5: Memanggil /reverse pada transaksi SCHEDULED -> 409 CANNOT_REVERSE_SCHEDULED', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Rev AC-5',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-15T00:00:00.000Z'),
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/reverse`)
        .set(userAHeaders)
        .send({
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CANNOT_REVERSE_SCHEDULED');
    });

    it('AC-6 (isolasi): User B me-reverse transaksi User A -> 404 TRANSACTION_NOT_FOUND', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Rev AC-6',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/reverse`)
        .set(userBHeaders)
        .send({
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('CANCEL SCHEDULED TRANSACTION (TASK-048)', () => {
    it('AC-1: Transaksi EXPENSE status = SCHEDULED -> POST /transactions/:id/cancel -> 200 { id, status: CANCELLED, cancelled_at }, saldo tidak berubah, 1 audit CANCEL', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Cancel AC-1',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-15T00:00:00.000Z'),
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const cancelUlid = generateTestUlid();
      const res = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/cancel`)
        .set(userAHeaders)
        .send({
          client_tx_id: cancelUlid,
          reason: 'Batal beli',
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(tx.id);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.cancelled_at).toBeDefined();

      // Saldo akun tidak berubah
      const accAfter = await prisma.account.findFirst({
        where: { id: acc.id, user_id: userAId },
      });
      expect(accAfter!.balance).toBe(500000n);

      // Transaksi berstatus CANCELLED di DB
      const txAfter = await prisma.asSystem().transaction.findUnique({
        where: { id: tx.id },
      });
      expect(txAfter!.status).toBe('CANCELLED');
      expect(txAfter!.cancelled_at).not.toBeNull();
      expect(txAfter!.reason).toBe('Batal beli');

      // 1 baris TransactionAudit action = CANCEL
      const audits = await prisma.asSystem().transactionAudit.findMany({
        where: { transaction_id: tx.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('CANCEL');
      expect(audits[0].reason).toBe('Batal beli');
      expect(audits[0].before).toMatchObject({ status: 'SCHEDULED' });
      expect(audits[0].after).toMatchObject({ status: 'CANCELLED' });
    });

    it('AC-2: Memanggil POST /transactions/:id/cancel pada transaksi POSTED -> 409 NOT_SCHEDULED', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Cancel AC-2',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 450000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/cancel`)
        .set(userAHeaders)
        .send({
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_SCHEDULED');
    });

    it('AC-3: Jika baris sedang dikunci (55P03), endpoint mengembalikan 409 RACE_CONDITION tanpa lost update', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Cancel AC-3',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const scheduledTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-20T00:00:00.000Z'),
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      let releaseLock: () => void;
      const lockPromise = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      // Tahan row lock di PostgreSQL via transaksi DB terpisah
      const lockHolder = prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT id FROM transactions WHERE id = '${scheduledTx.id}'::uuid FOR UPDATE`,
        );
        await lockPromise;
      });

      // Beri jeda kecil agar kueri lock telah dieksekusi di database
      await new Promise((r) => setTimeout(r, 100));

      const res = await request(app.getHttpServer())
        .post(`/transactions/${scheduledTx.id}/cancel`)
        .set(userAHeaders)
        .send({
          client_tx_id: generateTestUlid(),
        });

      // Lepas lock
      releaseLock!();
      await lockHolder;

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RACE_CONDITION');

      // Pastikan transaksi tidak mengalami lost update
      const intactTx = await prisma.asSystem().transaction.findUnique({
        where: { id: scheduledTx.id },
      });
      expect(intactTx!.status).toBe('SCHEDULED');
      expect(intactTx!.cancelled_at).toBeNull();
    });

    it('AC-4 (isolasi): User B membatalkan transaksi SCHEDULED milik User A -> 404 TRANSACTION_NOT_FOUND', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Cancel AC-4',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-20T00:00:00.000Z'),
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/cancel`)
        .set(userBHeaders)
        .send({
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('Batalkan scheduled transfer Metode A -> membatalkan TRANSFER dan EXPENSE fee atomic', async () => {
      const fromAcc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Cancel Transfer Dari',
          type: 'BANK',
          opening_balance: 1000000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 1000000n,
        },
      });
      const toAcc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Cancel Transfer Ke',
          type: 'EWALLET',
          opening_balance: 0n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 0n,
        },
      });

      const transferGroupId = '00000000-0000-4000-8000-000000000048';
      const transferTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: fromAcc.id,
          to_account_id: toAcc.id,
          type: 'TRANSFER',
          amount: 100000n,
          date: new Date('2026-11-25T00:00:00.000Z'),
          status: 'SCHEDULED',
          transfer_group_id: transferGroupId,
          transfer_fee: 6500n,
          fee_mode: 'SEPARATE',
          client_tx_id: generateTestUlid(),
        },
      });

      const feeTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: fromAcc.id,
          type: 'EXPENSE',
          amount: 6500n,
          date: new Date('2026-11-25T00:00:00.000Z'),
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          transfer_group_id: transferGroupId,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/transactions/${transferTx.id}/cancel`)
        .set(userAHeaders)
        .send({
          client_tx_id: generateTestUlid(),
          reason: 'Batal kirim uang',
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(transferTx.id);
      expect(res.body.status).toBe('CANCELLED');

      const updatedTransfer = await prisma.asSystem().transaction.findUnique({
        where: { id: transferTx.id },
      });
      const updatedFee = await prisma.asSystem().transaction.findUnique({
        where: { id: feeTx.id },
      });
      expect(updatedTransfer!.status).toBe('CANCELLED');
      expect(updatedFee!.status).toBe('CANCELLED');
      expect(updatedTransfer!.reason).toBe('Batal kirim uang');
      expect(updatedFee!.reason).toBe('Batal kirim uang');

      // Saldo kedua akun tetap tidak berubah
      const checkFrom = await prisma.account.findFirst({
        where: { id: fromAcc.id, user_id: userAId },
      });
      const checkTo = await prisma.account.findFirst({
        where: { id: toAcc.id, user_id: userAId },
      });
      expect(checkFrom!.balance).toBe(1000000n);
      expect(checkTo!.balance).toBe(0n);
    });

    it('Tolak 422 MISSING_CLIENT_TX_ID tanpa client_tx_id & tanpa header Idempotency-Key; terima 200 dengan Idempotency-Key header', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Cancel Idemp',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 500000n,
        },
      });

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: acc.id,
          type: 'EXPENSE',
          amount: 25000n,
          date: new Date('2026-11-20T00:00:00.000Z'),
          status: 'SCHEDULED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      // 1. Tanpa client_tx_id dan tanpa header
      const resMissing = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/cancel`)
        .set(userAHeaders)
        .send({});

      expect(resMissing.status).toBe(422);
      expect(resMissing.body.code).toBe('MISSING_CLIENT_TX_ID');

      // 2. Dengan header Idempotency-Key (tanpa body)
      const resHeader = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/cancel`)
        .set({
          ...userAHeaders,
          'Idempotency-Key': generateTestUlid(),
        })
        .send({});

      expect(resHeader.status).toBe(200);
      expect(resHeader.body.status).toBe('CANCELLED');
    });
  });

  describe('TRANSACTION ATTACHMENTS (TASK-049 & TASK-090)', () => {
    const originalFetch = global.fetch;

    beforeAll(() => {
      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ public_id: 'mock-public-id', result: 'ok' }),
        text: async () =>
          JSON.stringify({ public_id: 'mock-public-id', result: 'ok' }),
      })) as any;
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    const jpegBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      ...Array(100).fill(0),
    ]);

    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      ...Array(100).fill(0),
    ]);

    const webpBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ...Array(100).fill(0),
    ]);

    const textBuffer = Buffer.from('Not an image content at all');

    it('AC-4: Upload file > 5 MB -> 422 FILE_TOO_LARGE', async () => {
      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: userAAccount.id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const largeBuffer = Buffer.alloc(6 * 1024 * 1024);
      largeBuffer[0] = 0xff;
      largeBuffer[1] = 0xd8;
      largeBuffer[2] = 0xff;

      const resLarge = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments`)
        .set(userAHeaders)
        .attach('file', largeBuffer, 'large.jpg');

      expect([413, 422]).toContain(resLarge.status);
      expect(resLarge.body.code).toBe('FILE_TOO_LARGE');
    });

    it('AC-3: Upload file teks yang di-rename .jpg -> 422 INVALID_FILE_TYPE, baris tidak disimpan', async () => {
      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: userAAccount.id,
          type: 'EXPENSE',
          amount: 20000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const resText = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments`)
        .set(userAHeaders)
        .attach('file', textBuffer, 'fake.jpg');

      expect(resText.status).toBe(422);
      expect(resText.body.code).toBe('INVALID_FILE_TYPE');

      const count = await prisma.asSystem().fileAttachment.count({
        where: { transaction_id: tx.id },
      });
      expect(count).toBe(0);
    });

    it('AC-2, AC-4, AC-5: Upload JPEG/PNG/WebP valid -> 201, ke-4 -> 409 ATTACHMENT_LIMIT_EXCEEDED, GET signed URL ~1 jam, DELETE -> 204', async () => {
      if (throttlerStorage.storage) {
        throttlerStorage.storage.clear();
      }

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: userAAccount.id,
          type: 'EXPENSE',
          amount: 75000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const items = [
        { buf: jpegBuffer, name: 'receipt1.jpg' },
        { buf: pngBuffer, name: 'receipt2.png' },
        { buf: webpBuffer, name: 'receipt3.webp' },
      ];

      const confirmedIds: string[] = [];

      for (const item of items) {
        const uploadRes = await request(app.getHttpServer())
          .post(`/transactions/${tx.id}/attachments`)
          .set(userAHeaders)
          .attach('file', item.buf, item.name);

        expect(uploadRes.status).toBe(201);
        expect(uploadRes.body.attachment_id).toBeDefined();
        expect(uploadRes.body.access_url).toContain('api.cloudinary.com/v1_1/');
        expect(uploadRes.body.access_url).toContain('image/download');
        expect(uploadRes.body.expires_at).toBeDefined();
        confirmedIds.push(uploadRes.body.attachment_id);
      }

      // Upload ke-4 -> 409 ATTACHMENT_LIMIT_EXCEEDED
      const upload4 = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments`)
        .set(userAHeaders)
        .attach('file', jpegBuffer, 'fourth.jpg');

      expect(upload4.status).toBe(409);
      expect(upload4.body.code).toBe('ATTACHMENT_LIMIT_EXCEEDED');

      // AC-2 & AC-5: GET signed URL 1 jam (+3600 detik)
      const nowBefore = Date.now();
      const urlRes = await request(app.getHttpServer())
        .get(`/transactions/${tx.id}/attachments/${confirmedIds[0]}/url`)
        .set(userAHeaders);
      expect(urlRes.status).toBe(200);
      expect(urlRes.body.access_url).toContain('api.cloudinary.com/v1_1/');
      expect(urlRes.body.access_url).toContain('image/download');
      const expiresMs = new Date(urlRes.body.expires_at).getTime();
      const diffSec = (expiresMs - nowBefore) / 1000;
      expect(diffSec).toBeGreaterThanOrEqual(3595);
      expect(diffSec).toBeLessThanOrEqual(3605);

      // DELETE lampiran -> 204
      const delRes = await request(app.getHttpServer())
        .delete(`/transactions/${tx.id}/attachments/${confirmedIds[0]}`)
        .set(userAHeaders);
      expect(delRes.status).toBe(204);

      const remaining = await prisma.asSystem().fileAttachment.count({
        where: { transaction_id: tx.id },
      });
      expect(remaining).toBe(2);
    });

    it('AC-6 (isolasi): User B mengakses upload/get-url/delete pada transaksi User A -> 404', async () => {
      if (throttlerStorage.storage) {
        throttlerStorage.storage.clear();
      }

      const tx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: userAAccount.id,
          type: 'EXPENSE',
          amount: 40000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          category_id: expenseCategoryA.id,
          client_tx_id: generateTestUlid(),
        },
      });

      const att = await prisma.asSystem().fileAttachment.create({
        data: {
          transaction_id: tx.id,
          storage_key: `users/${userAId}/tx/${tx.id}/isolated-att`,
          mime: 'image/jpeg',
          size_bytes: 120000n,
          uploaded_by: userAId,
        },
      });

      const resOtherUpload = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments`)
        .set(userBHeaders)
        .attach('file', jpegBuffer, 'attempt.jpg');
      expect(resOtherUpload.status).toBe(404);

      const resUrl = await request(app.getHttpServer())
        .get(`/transactions/${tx.id}/attachments/${att.id}/url`)
        .set(userBHeaders);
      expect(resUrl.status).toBe(404);

      const resDel = await request(app.getHttpServer())
        .delete(`/transactions/${tx.id}/attachments/${att.id}`)
        .set(userBHeaders);
      expect(resDel.status).toBe(404);
    });

    it('AC-7: Upload ke transaksi bertipe REVERSAL -> 409 ATTACHMENT_NOT_ALLOWED_ON_REVERSAL', async () => {
      const revTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: userAAccount.id,
          type: 'REVERSAL',
          amount: 15000n,
          date: new Date('2026-11-01T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: generateTestUlid(),
        },
      });

      const resRev = await request(app.getHttpServer())
        .post(`/transactions/${revTx.id}/attachments`)
        .set(userAHeaders)
        .attach('file', jpegBuffer, 'reversal.jpg');

      expect(resRev.status).toBe(409);
      expect(resRev.body.code).toBe('ATTACHMENT_NOT_ALLOWED_ON_REVERSAL');
    });

    it('AC-9: Route presign sudah dihapus -> 404', async () => {
      const resPresign = await request(app.getHttpServer())
        .post(`/transactions/00000000-0000-0000-0000-000000000000/attachments/presign`)
        .set(userAHeaders)
        .send({});

      expect(resPresign.status).toBe(404);
    });
  });

  describe('FR-TRX-011: Saldo Negatif & Detail Resolusi (TASK-050)', () => {
    it('AC-1: allow_negative = false, balance = 10000 -> EXPENSE 20000 -> 409 INSUFFICIENT_BALANCE dengan details lengkap & saldo tidak berubah', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Negatif AC1 ' + Date.now(),
          type: 'BANK',
          opening_balance: 10000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 10000n,
          allow_negative: false,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          account_id: acc.id,
          amount: 20000,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(res.body.message).toBe(
        'Saldo akun tidak mencukupi. Sesuaikan saldo atau izinkan saldo negatif untuk akun ini.',
      );
      expect(res.body.details).toEqual({
        account_id: acc.id,
        ledger_balance: 10000,
        reserved: 0,
        available: 10000,
        needed: 20000,
        shortfall: 10000,
        resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
      });

      const accAfter = await prisma.account.findFirst({ where: { id: acc.id, user_id: userAId } });
      expect(accAfter!.balance).toBe(10000n);
    });

    it('AC-2: Setelah user PATCH /accounts/:id/allow-negative { allow_negative: true }, EXPENSE 20000 berhasil 201 dengan warning NEGATIVE_BALANCE dan balance = -10000', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Negatif AC2 ' + Date.now(),
          type: 'BANK',
          opening_balance: 10000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 10000n,
          allow_negative: false,
        },
      });

      // 1. Toggle allow_negative via endpoint
      const patchRes = await request(app.getHttpServer())
        .patch(`/accounts/${acc.id}/allow-negative`)
        .set(userAHeaders)
        .send({ allow_negative: true });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.allow_negative).toBe(true);

      // Pastikan tercatat di audit_logs
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          resource_type: 'account',
          resource_id: acc.id,
          action: 'ACCOUNT_ALLOW_NEGATIVE_UPDATE',
        },
      });
      expect(auditLog).toBeDefined();

      // 2. Request EXPENSE 20000 yang sama
      const expRes = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          account_id: acc.id,
          amount: 20000,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });

      expect(expRes.status).toBe(201);
      expect(expRes.body.warning).toBe('NEGATIVE_BALANCE');

      const accAfter = await prisma.account.findFirst({ where: { id: acc.id, user_id: userAId } });
      expect(accAfter!.balance).toBe(-10000n);
    });

    it('AC-3: Transfer keluar dari akun negatif (balance = -10000) berhasil dengan warning NEGATIVE_BALANCE bila allow_negative = true, dan ditolak 409 bila allow_negative = false', async () => {
      // Akun asal negatif dengan allow_negative = false
      const sourceAccFalse = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Transfer Negatif False ' + Date.now(),
          type: 'BANK',
          opening_balance: -10000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: -10000n,
          allow_negative: false,
        },
      });

      const destAcc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Tujuan Transfer ' + Date.now(),
          type: 'BANK',
          opening_balance: 50000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 50000n,
        },
      });

      // Transfer dari akun asal (allow_negative = false) -> ditolak 409
      const resFalse = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'TRANSFER',
          account_id: sourceAccFalse.id,
          to_account_id: destAcc.id,
          amount: 5000,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });
      expect(resFalse.status).toBe(409);
      expect(resFalse.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(resFalse.body.details).toEqual({
        account_id: sourceAccFalse.id,
        ledger_balance: -10000,
        reserved: 0,
        available: -10000,
        needed: 5000,
        shortfall: 15000,
        resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
      });

      // Akun asal negatif dengan allow_negative = true
      const sourceAccTrue = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Transfer Negatif True ' + Date.now(),
          type: 'BANK',
          opening_balance: -10000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: -10000n,
          allow_negative: true,
        },
      });

      // Transfer dari akun asal (allow_negative = true) -> 201 dengan warning
      const resTrue = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'TRANSFER',
          account_id: sourceAccTrue.id,
          to_account_id: destAcc.id,
          amount: 5000,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });
      expect(resTrue.status).toBe(201);
      expect(resTrue.body.warning).toBe('NEGATIVE_BALANCE');

      const sourceAfter = await prisma.account.findFirst({ where: { id: sourceAccTrue.id, user_id: userAId } });
      expect(sourceAfter!.balance).toBe(-15000n);
    });

    it('AC-4: PATCH /transactions/:id dan POST /transactions/:id/reverse yang menyebabkan saldo < 0 pada allow_negative = false ditolak 409 INSUFFICIENT_BALANCE dengan details identik', async () => {
      const acc = await prisma.account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Patch Reverse AC4 ' + Date.now(),
          type: 'BANK',
          opening_balance: 10000n,
          opening_date: new Date('2026-11-01T00:00:00.000Z'),
          balance: 10000n,
          allow_negative: false,
        },
      });

      // 1. Buat income 20000 -> saldo jadi 30000
      const incRes = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'INCOME',
          account_id: acc.id,
          amount: 20000,
          category_id: incomeCategoryA.id,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });
      expect(incRes.status).toBe(201);

      // 2. Buat expense 25000 -> saldo jadi 5000
      const expRes = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          account_id: acc.id,
          amount: 25000,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
          client_tx_id: generateTestUlid(),
        });
      expect(expRes.status).toBe(201);

      // 3. PATCH expense dari 25000 menjadi 35000 (butuh tambahan 10000, tapi balance hanya 5000) -> 409
      const patchRes = await request(app.getHttpServer())
        .patch(`/transactions/${expRes.body.id}`)
        .set(userAHeaders)
        .send({
          amount: 35000,
          client_tx_id: generateTestUlid(),
        });
      expect(patchRes.status).toBe(409);
      expect(patchRes.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(patchRes.body.message).toBe(
        'Saldo akun tidak mencukupi. Sesuaikan saldo atau izinkan saldo negatif untuk akun ini.',
      );
      expect(patchRes.body.details).toEqual({
        account_id: acc.id,
        ledger_balance: 5000,
        reserved: 0,
        available: 5000,
        needed: 10000,
        shortfall: 5000,
        resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
      });

      // 4. POST reverse pada income 20000 (butuh 20000, saldo hanya 5000) -> 409
      const revRes = await request(app.getHttpServer())
        .post(`/transactions/${incRes.body.id}/reverse`)
        .set(userAHeaders)
        .send({
          reason: 'Pembalikan income',
          client_tx_id: generateTestUlid(),
        });
      expect(revRes.status).toBe(409);
      expect(revRes.body.code).toBe('INSUFFICIENT_BALANCE');
      expect(revRes.body.message).toBe(
        'Saldo akun tidak mencukupi. Sesuaikan saldo atau izinkan saldo negatif untuk akun ini.',
      );
      expect(revRes.body.details).toEqual({
        account_id: acc.id,
        ledger_balance: 5000,
        reserved: 0,
        available: 5000,
        needed: 20000,
        shortfall: 15000,
        resolution_options: ['ADJUST_BALANCE', 'ALLOW_NEGATIVE'],
      });
    });
  });

  describe('IDEMPOTENCY GLOBAL ENFORCEMENT (TASK-052)', () => {
    it('AC-1: POST /transactions dengan client_tx_id sukses (201) -> retry identik via body & header menghasilkan 201 dengan body persis sama tanpa transaksi ganda', async () => {
      // 1. Buat akun baru dengan saldo 100000
      const acc = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Idempotency AC1',
          type: 'BANK',
          provider: 'BCA',
          balance: 100000n,
          opening_balance: 100000n,
          opening_date: new Date('2026-01-01'),
          allow_negative: false,
        },
      });

      const key = generateTestUlid();
      const payload = {
        type: 'EXPENSE',
        amount: 25000,
        account_id: acc.id,
        category_id: expenseCategoryA.id,
        date: '2026-11-01',
        client_tx_id: key,
      };

      // Request pertama
      const res1 = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send(payload);

      expect(res1.status).toBe(201);
      expect(res1.body.id).toBeDefined();
      expect(res1.body.amount).toBe(25000);
      expect(res1.body.client_tx_id).toBe(key);

      // Cek database: baris IdempotencyKey tersimpan dengan TTL ~30 hari
      const ikRow = await prisma.asSystem().idempotencyKey.findUnique({
        where: {
          user_id_client_tx_id: {
            user_id: userAId,
            client_tx_id: key,
          },
        },
      });
      expect(ikRow).not.toBeNull();
      expect(ikRow?.response_status).toBe(201);
      expect(ikRow?.response_body).toEqual(res1.body);
      const daysUntilExpire = Math.round(
        (ikRow!.ttl_expires_at.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(daysUntilExpire).toBe(30);

      // Request kedua: retry identik via body
      const res2 = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.body).toEqual(res1.body);

      // Request ketiga: retry identik via header Idempotency-Key (tanpa client_tx_id di body)
      const { client_tx_id: _, ...payloadWithoutKey } = payload;
      const res3 = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .set('idempotency-key', key)
        .send(payloadWithoutKey);

      expect(res3.status).toBe(201);
      expect(res3.body).toEqual(res1.body);

      // Verifikasi: hanya ada 1 transaksi di DB dan saldo akun hanya berkurang 1x (100000 - 25000 = 75000)
      const txCount = await prisma.asSystem().transaction.count({
        where: {
          account_id: acc.id,
        },
      });
      expect(txCount).toBe(1);

      const accUpdated = await prisma.asSystem().account.findUnique({
        where: { id: acc.id },
      });
      expect(Number(accUpdated?.balance)).toBe(75000);
    });

    it('AC-2: Menggunakan client_tx_id yang sudah dipakai untuk request dengan nominal/tipe berbeda -> 409 IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD', async () => {
      const acc = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Idempotency AC2',
          type: 'BANK',
          provider: 'BCA',
          balance: 100000n,
          opening_balance: 100000n,
          opening_date: new Date('2026-01-01'),
          allow_negative: false,
        },
      });

      const key = generateTestUlid();
      const payload1 = {
        type: 'EXPENSE',
        amount: 20000,
        account_id: acc.id,
        category_id: expenseCategoryA.id,
        date: '2026-11-01',
        client_tx_id: key,
      };

      const res1 = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send(payload1);
      expect(res1.status).toBe(201);

      // Request dengan nominal berbeda dan key sama
      const payload2 = {
        type: 'EXPENSE',
        amount: 30000,
        account_id: acc.id,
        category_id: expenseCategoryA.id,
        date: '2026-11-01',
        client_tx_id: key,
      };
      const res2 = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send(payload2);

      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe('IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');
      expect(res2.body.message).toBe('client_tx_id sudah digunakan dengan payload berbeda');
    });

    it('AC-3: Memanggil mutasi transaksi tanpa client_tx_id & tanpa header Idempotency-Key -> 422 MISSING_CLIENT_TX_ID', async () => {
      // 1. POST /transactions
      const resPost = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          amount: 10000,
          account_id: userAAccount.id,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
        });
      expect(resPost.status).toBe(422);
      expect(resPost.body.code).toBe('MISSING_CLIENT_TX_ID');

      // 2. PATCH /transactions/:id
      const resPatch = await request(app.getHttpServer())
        .patch(`/transactions/${userAAccount.id}`)
        .set(userAHeaders)
        .send({
          amount: 15000,
        });
      expect(resPatch.status).toBe(422);
      expect(resPatch.body.code).toBe('MISSING_CLIENT_TX_ID');

      // 3. POST /transactions/:id/reverse
      const resRev = await request(app.getHttpServer())
        .post(`/transactions/${userAAccount.id}/reverse`)
        .set(userAHeaders)
        .send({
          reason: 'Alasan pembatalan',
        });
      expect(resRev.status).toBe(422);
      expect(resRev.body.code).toBe('MISSING_CLIENT_TX_ID');

      // 4. POST /transactions/:id/cancel
      const resCancel = await request(app.getHttpServer())
        .post(`/transactions/${userAAccount.id}/cancel`)
        .set(userAHeaders)
        .send({});
      expect(resCancel.status).toBe(422);
      expect(resCancel.body.code).toBe('MISSING_CLIENT_TX_ID');
    });

    it('AC-4: Isolasi tenant - User B dapat menggunakan client_tx_id yang sama dengan User A tanpa konflik', async () => {
      const keyShared = generateTestUlid();

      // User A membuat transaksi dengan keyShared
      const resA = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          amount: 15000,
          account_id: userAAccount.id,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
          client_tx_id: keyShared,
        });
      expect(resA.status).toBe(201);

      // User B membuat transaksi dengan keyShared yang sama
      const catB = await prisma.asSystem().category.findFirst({
        where: { user_id: userBId, type: 'INCOME' },
      });
      const resB = await request(app.getHttpServer())
        .post('/transactions')
        .set(userBHeaders)
        .send({
          type: 'INCOME',
          amount: 25000,
          account_id: userBAccount.id,
          category_id: catB!.id,
          date: '2026-11-01',
          client_tx_id: keyShared,
        });
      expect(resB.status).toBe(201);
      expect(resB.body.amount).toBe(25000);

      // Pastikan ada 2 baris idempotency_keys terpisah di DB untuk masing-masing user
      const keysA = await prisma.asSystem().idempotencyKey.findMany({
        where: { client_tx_id: keyShared },
      });
      expect(keysA.length).toBe(2);
      expect(keysA.map((k) => k.user_id).sort()).toEqual([userAId, userBId].sort());
    });

    it('Replay pada PATCH dan POST reverse menghasilkan respons identik', async () => {
      // 1. Buat transaksi EXPENSE untuk di-patch
      const txKey = generateTestUlid();
      const createRes = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          amount: 50000,
          account_id: userAAccount.id,
          category_id: expenseCategoryA.id,
          date: '2026-11-01',
          client_tx_id: txKey,
        });
      expect(createRes.status).toBe(201);
      const txId = createRes.body.id;

      // 2. PATCH transaksi dengan patchKey
      const patchKey = generateTestUlid();
      const patchRes1 = await request(app.getHttpServer())
        .patch(`/transactions/${txId}`)
        .set(userAHeaders)
        .send({
          amount: 40000,
          client_tx_id: patchKey,
        });
      expect(patchRes1.status).toBe(200);

      // Retry PATCH dengan patchKey yang sama
      const patchRes2 = await request(app.getHttpServer())
        .patch(`/transactions/${txId}`)
        .set(userAHeaders)
        .send({
          amount: 40000,
          client_tx_id: patchKey,
        });
      expect(patchRes2.status).toBe(200);
      expect(patchRes2.body).toEqual(patchRes1.body);

      // 3. Reverse transaksi dengan reverseKey
      const revKey = generateTestUlid();
      const revRes1 = await request(app.getHttpServer())
        .post(`/transactions/${txId}/reverse`)
        .set(userAHeaders)
        .send({
          reason: 'Pembalikan untuk idempotensi e2e',
          client_tx_id: revKey,
        });
      expect(revRes1.status).toBe(201);

      // Retry reverse dengan revKey yang sama -> tetap 201 replayed (bukan 409 ALREADY_REVERSED!)
      const revRes2 = await request(app.getHttpServer())
        .post(`/transactions/${txId}/reverse`)
        .set(userAHeaders)
        .send({
          reason: 'Pembalikan untuk idempotensi e2e',
          client_tx_id: revKey,
        });
      expect(revRes2.status).toBe(201);
      expect(revRes2.body).toEqual(revRes1.body);
    });
  });

  describe('LIST AND DETAIL TRANSACTIONS (TASK-053)', () => {
    let tag1: any;
    let tag2: any;
    let listAcc: any;

    beforeAll(async () => {
      listAcc = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun List Test',
          type: 'BANK',
          provider: 'BCA',
          balance: 1000000n,
          opening_balance: 1000000n,
          opening_date: new Date('2026-01-01'),
          allow_negative: false,
        },
      });

      tag1 = await prisma.asSystem().tag.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'TagOne-' + Date.now(),
          color: 'blue',
          archived: false,
        },
      });

      tag2 = await prisma.asSystem().tag.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'TagTwo-' + Date.now(),
          color: 'emerald',
          archived: false,
        },
      });
    });

    it('AC-1: GET /transactions cursor pagination mengembalikan limit item dan halaman ke-2 menyisakan sisa dengan next_cursor null', async () => {
      // Buat 3 transaksi EXPENSE di bulan Januari 2026
      for (const d of ['2026-01-10', '2026-01-15', '2026-01-20']) {
        const res = await request(app.getHttpServer())
          .post('/transactions')
          .set(userAHeaders)
          .send({
            type: 'EXPENSE',
            amount: 10000,
            account_id: listAcc.id,
            category_id: expenseCategoryA.id,
            date: d,
            client_tx_id: generateTestUlid(),
          });
        expect(res.status).toBe(201);
      }

      // Query page 1 limit 2
      const resPage1 = await request(app.getHttpServer())
        .get('/transactions')
        .set(userAHeaders)
        .query({
          type: 'EXPENSE',
          date_from: '2026-01-01',
          date_to: '2026-01-31',
          limit: 2,
        });

      expect(resPage1.status).toBe(200);
      expect(resPage1.body.items.length).toBe(2);
      expect(resPage1.body.next_cursor).toBeTruthy();

      // Query page 2 dengan cursor
      const resPage2 = await request(app.getHttpServer())
        .get('/transactions')
        .set(userAHeaders)
        .query({
          type: 'EXPENSE',
          date_from: '2026-01-01',
          date_to: '2026-01-31',
          limit: 2,
          cursor: resPage1.body.next_cursor,
        });

      expect(resPage2.status).toBe(200);
      expect(resPage2.body.items.length).toBe(1);
      expect(resPage2.body.next_cursor).toBeNull();
    });

    it('AC-2: GET /transactions?q=makan menemukan transaksi case-insensitive pada note/category/tag', async () => {
      const qTx = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          amount: 25000,
          account_id: listAcc.id,
          category_id: expenseCategoryA.id,
          date: '2026-02-01',
          note: 'Makan siang warteg',
          client_tx_id: generateTestUlid(),
        });
      expect(qTx.status).toBe(201);

      const res = await request(app.getHttpServer())
        .get('/transactions')
        .set(userAHeaders)
        .query({ q: 'makan' });

      expect(res.status).toBe(200);
      const found = res.body.items.find((i: any) => i.id === qTx.body.id);
      expect(found).toBeDefined();
      expect(found.note).toContain('Makan');
    });

    it('AC-3: GET /transactions?status=SCHEDULED hanya mengembalikan transaksi terjadwal', async () => {
      const schRes = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          amount: 30000,
          account_id: listAcc.id,
          category_id: expenseCategoryA.id,
          date: '2026-12-25', // Masa depan -> SCHEDULED
          client_tx_id: generateTestUlid(),
        });
      expect(schRes.status).toBe(201);
      expect(schRes.body.status).toBe('SCHEDULED');

      const res = await request(app.getHttpServer())
        .get('/transactions')
        .set(userAHeaders)
        .query({ status: 'SCHEDULED' });

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      for (const item of res.body.items) {
        expect(item.status).toBe('SCHEDULED');
        expect(item.is_scheduled).toBe(true);
      }
    });

    it('AC-4: GET /transactions?tag_id=t1&tag_id=t2 menggunakan multi-tag AND semantics', async () => {
      // Transaksi A: punya tag1 dan tag2
      const txBoth = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          amount: 40000,
          account_id: listAcc.id,
          category_id: expenseCategoryA.id,
          date: '2026-03-01',
          tags: [tag1.id, tag2.id],
          client_tx_id: generateTestUlid(),
        });
      expect(txBoth.status).toBe(201);

      // Transaksi B: hanya punya tag1
      const txOnly1 = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          amount: 45000,
          account_id: listAcc.id,
          category_id: expenseCategoryA.id,
          date: '2026-03-02',
          tags: [tag1.id],
          client_tx_id: generateTestUlid(),
        });
      expect(txOnly1.status).toBe(201);

      // Query tag_id=tag1.id&tag_id=tag2.id -> hanya txBoth yang cocok
      const res = await request(app.getHttpServer())
        .get(`/transactions?tag_id=${tag1.id}&tag_id=${tag2.id}`)
        .set(userAHeaders);

      expect(res.status).toBe(200);
      const ids = res.body.items.map((i: any) => i.id);
      expect(ids).toContain(txBoth.body.id);
      expect(ids).not.toContain(txOnly1.body.id);
    });

    it('AC-5: GET /transactions?cursor=bukan-cursor-valid -> 400 INVALID_CURSOR', async () => {
      const res = await request(app.getHttpServer())
        .get('/transactions?cursor=bukan-cursor-valid')
        .set(userAHeaders);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CURSOR');
    });

    it('AC-6: GET /transactions/:id mengembalikan detail lengkap dan menolak 404 pada transaksi milik user lain', async () => {
      // 1. Buat transaksi dengan split dan tag
      const txRes = await request(app.getHttpServer())
        .post('/transactions')
        .set(userAHeaders)
        .send({
          type: 'EXPENSE',
          amount: 60000,
          account_id: listAcc.id,
          date: '2026-03-10',
          splits: [
            { category_id: expenseCategoryA.id, amount: 40000 },
            { category_id: expenseCategoryA.id, amount: 20000 },
          ],
          tags: [tag1.id],
          client_tx_id: generateTestUlid(),
        });
      expect(txRes.status).toBe(201);
      const txId = txRes.body.id;

      // 2. GET detail oleh User A
      const detailRes = await request(app.getHttpServer())
        .get(`/transactions/${txId}`)
        .set(userAHeaders);

      expect(detailRes.status).toBe(200);
      expect(detailRes.body.transaction.id).toBe(txId);
      expect(detailRes.body.splits.length).toBe(2);
      expect(detailRes.body.tags.length).toBe(1);
      expect(detailRes.body.tags[0].name).toBe(tag1.name);
      expect(Array.isArray(detailRes.body.attachments)).toBe(true);
      expect(Array.isArray(detailRes.body.audit)).toBe(true);

      // 3. User B mengakses detail transaksi User A -> 404 TRANSACTION_NOT_FOUND
      const userBDetailRes = await request(app.getHttpServer())
        .get(`/transactions/${txId}`)
        .set(userBHeaders);

      expect(userBDetailRes.status).toBe(404);
      expect(userBDetailRes.body.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });
});
