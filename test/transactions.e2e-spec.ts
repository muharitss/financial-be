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
        available: 30000,
        needed: 50000,
        account_id: acc.id,
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
        available: 100000,
        needed: 200000,
        account_id: acc.id,
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

  describe('TRANSACTION ATTACHMENTS (TASK-049)', () => {
    const jpegHeaderBase64 = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]).toString('base64');

    const pngHeaderBase64 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]).toString('base64');

    const webpHeaderBase64 = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]).toString('base64');

    const fakeTextBase64 = Buffer.from('Not an image content at all').toString(
      'base64',
    );

    it('AC-1 & AC-2: Presign valid (3 MB) -> 200 { upload_url, storage_key }; Presign > 5 MB -> 422 FILE_TOO_LARGE', async () => {
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

      const resOk = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments/presign`)
        .set(userAHeaders)
        .send({ mime: 'image/jpeg', size: 3_000_000 });

      expect(resOk.status).toBe(200);
      expect(resOk.body.upload_url).toBeDefined();
      expect(resOk.body.storage_key).toContain(`users/${userAId}/tx/${tx.id}/`);

      const resLarge = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments/presign`)
        .set(userAHeaders)
        .send({ mime: 'image/jpeg', size: 6_000_000 });

      expect(resLarge.status).toBe(422);
      expect(resLarge.body.code).toBe('FILE_TOO_LARGE');
    });

    it('AC-3: Confirm dengan mime image/jpeg tetapi magic_bytes_base64 berisi teks/PNG -> 422 INVALID_FILE_TYPE, baris tidak disimpan', async () => {
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

      const presignRes = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments/presign`)
        .set(userAHeaders)
        .send({ mime: 'image/jpeg', size: 500_000 });

      const resText = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments`)
        .set(userAHeaders)
        .send({
          storage_key: presignRes.body.storage_key,
          mime: 'image/jpeg',
          size_bytes: 500_000,
          magic_bytes_base64: fakeTextBase64,
        });

      expect(resText.status).toBe(422);
      expect(resText.body.code).toBe('INVALID_FILE_TYPE');

      const resMismatch = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments`)
        .set(userAHeaders)
        .send({
          storage_key: presignRes.body.storage_key,
          mime: 'image/jpeg',
          size_bytes: 500_000,
          magic_bytes_base64: pngHeaderBase64,
        });

      expect(resMismatch.status).toBe(422);
      expect(resMismatch.body.code).toBe('INVALID_FILE_TYPE');

      const count = await prisma.asSystem().fileAttachment.count({
        where: { transaction_id: tx.id },
      });
      expect(count).toBe(0);
    });

    it('AC-4 & AC-5: Confirm JPEG/PNG/WebP valid -> 201, ke-4 -> 409 ATTACHMENT_LIMIT_EXCEEDED, GET signed URL ~1 jam, DELETE -> 204', async () => {
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
        { mime: 'image/jpeg', magic: jpegHeaderBase64, size: 100_000 },
        { mime: 'image/png', magic: pngHeaderBase64, size: 200_000 },
        { mime: 'image/webp', magic: webpHeaderBase64, size: 150_000 },
      ];

      const confirmedIds: string[] = [];

      for (const item of items) {
        const presign = await request(app.getHttpServer())
          .post(`/transactions/${tx.id}/attachments/presign`)
          .set(userAHeaders)
          .send({ mime: item.mime, size: item.size });
        expect(presign.status).toBe(200);

        const confirm = await request(app.getHttpServer())
          .post(`/transactions/${tx.id}/attachments`)
          .set(userAHeaders)
          .send({
            storage_key: presign.body.storage_key,
            mime: item.mime,
            size_bytes: item.size,
            magic_bytes_base64: item.magic,
          });
        expect(confirm.status).toBe(201);
        expect(confirm.body.attachment_id).toBeDefined();
        expect(confirm.body.access_url).toBeDefined();
        confirmedIds.push(confirm.body.attachment_id);
      }

      // Presign ke-4 -> 409 ATTACHMENT_LIMIT_EXCEEDED
      const presign4 = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments/presign`)
        .set(userAHeaders)
        .send({ mime: 'image/jpeg', size: 100_000 });
      expect(presign4.status).toBe(409);
      expect(presign4.body.code).toBe('ATTACHMENT_LIMIT_EXCEEDED');

      // Confirm ke-4 -> 409 ATTACHMENT_LIMIT_EXCEEDED
      const confirm4 = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments`)
        .set(userAHeaders)
        .send({
          storage_key: `users/${userAId}/tx/${tx.id}/fourth-file`,
          mime: 'image/jpeg',
          size_bytes: 100_000,
          magic_bytes_base64: jpegHeaderBase64,
        });
      expect(confirm4.status).toBe(409);
      expect(confirm4.body.code).toBe('ATTACHMENT_LIMIT_EXCEEDED');

      // AC-5: GET signed URL 1 jam (+3600 detik)
      const nowBefore = Date.now();
      const urlRes = await request(app.getHttpServer())
        .get(`/transactions/${tx.id}/attachments/${confirmedIds[0]}/url`)
        .set(userAHeaders);
      expect(urlRes.status).toBe(200);
      expect(urlRes.body.access_url).toContain('image/authenticated/');
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

    it('AC-6 (isolasi): User B mengakses presign/confirm/get-url/delete pada transaksi User A -> 404', async () => {
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

      const resPresign = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments/presign`)
        .set(userBHeaders)
        .send({ mime: 'image/jpeg', size: 100_000 });
      expect(resPresign.status).toBe(404);

      const resConfirm = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/attachments`)
        .set(userBHeaders)
        .send({
          storage_key: `users/${userAId}/tx/${tx.id}/attempt`,
          mime: 'image/jpeg',
          size_bytes: 100_000,
          magic_bytes_base64: jpegHeaderBase64,
        });
      expect(resConfirm.status).toBe(404);

      const resUrl = await request(app.getHttpServer())
        .get(`/transactions/${tx.id}/attachments/${att.id}/url`)
        .set(userBHeaders);
      expect(resUrl.status).toBe(404);

      const resDel = await request(app.getHttpServer())
        .delete(`/transactions/${tx.id}/attachments/${att.id}`)
        .set(userBHeaders);
      expect(resDel.status).toBe(404);
    });
  });
});
