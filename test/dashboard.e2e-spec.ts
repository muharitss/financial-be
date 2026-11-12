import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DashboardService } from '../src/modules/dashboard/dashboard.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { todayInTz } from '../src/common/utils/date.js';

describe('Dashboard E2E Test Suite (Supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dashboardService: DashboardService;
  let throttlerStorage: any;

  let userAHeaders: { cookie: string };
  let userBHeaders: { cookie: string };
  let userEmptyHeaders: { cookie: string };

  let userAId: string;
  let userBId: string;
  let profileAId: string;
  let profileBId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    dashboardService = app.get(DashboardService);
    throttlerStorage = app.get(ThrottlerStorage);

    // Bersihkan test data
    await prisma.asSystem().notification.deleteMany();
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.asSystem().savingsGoal.deleteMany();
    await prisma.asSystem().transaction.deleteMany();
    await prisma.asSystem().account.deleteMany();
    await prisma.user.deleteMany({
      where: {
        email: { endsWith: '@dashboard-test.duitku' },
      },
    });

    // Registrasi User A
    const resA = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-a@dashboard-test.duitku',
        password: 'Password123!',
        name: 'User A',
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
        email: 'user-b@dashboard-test.duitku',
        password: 'Password123!',
        name: 'User B',
      });
    expect(resB.status).toBe(201);
    userBId = resB.body.user.id;
    const cookieB = resB.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userBHeaders = { cookie: cookieB };

    // Registrasi User Tanpa Akun
    const resEmpty = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-empty@dashboard-test.duitku',
        password: 'Password123!',
        name: 'User Empty',
      });
    expect(resEmpty.status).toBe(201);
    const cookieEmpty = resEmpty.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userEmptyHeaders = { cookie: cookieEmpty };

    const profileA = await prisma.asSystem().financialProfile.findFirstOrThrow({
      where: { user_id: userAId, is_default: true },
    });
    profileAId = profileA.id;

    const profileB = await prisma.asSystem().financialProfile.findFirstOrThrow({
      where: { user_id: userBId, is_default: true },
    });
    profileBId = profileB.id;
  });

  beforeEach(() => {
    throttlerStorage?._storage?.clear();
    throttlerStorage?.hitExpirations?.clear();
  });

  afterAll(async () => {
    await prisma.asSystem().notification.deleteMany();
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.asSystem().savingsGoal.deleteMany();
    await prisma.asSystem().transaction.deleteMany();
    await prisma.asSystem().account.deleteMany();
    await prisma.user.deleteMany({
      where: {
        email: { endsWith: '@dashboard-test.duitku' },
      },
    });
    await app.close();
  });

  it('AC-6: User tanpa akun -> 200 dengan semua angka 0 dan accounts_count = 0', async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard/balances')
      .set('Cookie', userEmptyHeaders.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ledger_balance: 0,
      reserved_total: 0,
      available_balance: 0,
      net_worth: 0,
      accounts_count: 0,
    });
    expect(typeof res.body.as_of).toBe('string');
  });

  it('AC-1: User dengan BCA (1.000.000, reserved 400.000), Dompet (-50.000), Reksa Dana (2.000.000), dan arsip (500.000)', async () => {
    const bca = await prisma.asSystem().account.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'BCA',
        type: 'BANK',
        opening_balance: 1000000n,
        balance: 1000000n,
        opening_date: new Date(),
        allow_negative: false,
        archived: false,
      },
    });

    await prisma.asSystem().account.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Dompet',
        type: 'CASH',
        opening_balance: -50000n,
        balance: -50000n,
        opening_date: new Date(),
        allow_negative: true,
        archived: false,
      },
    });

    await prisma.asSystem().account.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Reksa Dana',
        type: 'INVESTMENT',
        opening_balance: 2000000n,
        balance: 2000000n,
        opening_date: new Date(),
        allow_negative: false,
        archived: false,
      },
    });

    await prisma.asSystem().account.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Akun Arsip',
        type: 'BANK',
        opening_balance: 500000n,
        balance: 500000n,
        opening_date: new Date(),
        allow_negative: false,
        archived: true,
        archived_at: new Date(),
      },
    });

    const goal = await prisma.asSystem().savingsGoal.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Dana Darurat',
        target_amount: 10000000n,
      },
    });

    await prisma.asSystem().savingsAllocation.create({
      data: {
        savings_goal_id: goal.id,
        account_id: bca.id,
        amount: 400000n,
        status: 'ACTIVE',
      },
    });

    const res = await request(app.getHttpServer())
      .get('/dashboard/balances')
      .set('Cookie', userAHeaders.cookie);

    expect(res.status).toBe(200);
    expect(res.body.ledger_balance).toBe(2950000);
    expect(res.body.reserved_total).toBe(400000);
    expect(res.body.available_balance).toBe(550000);
    expect(res.body.net_worth).toBe(3000000);
    expect(res.body.accounts_count).toBe(3);
    expect(typeof res.body.as_of).toBe('string');
  });

  it('AC-2: Akun RECEIVABLE 300.000 menambah ledger_balance & net_worth tetapi tidak mengubah available_balance', async () => {
    await prisma.asSystem().account.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Piutang Budi',
        type: 'RECEIVABLE',
        opening_balance: 300000n,
        balance: 300000n,
        opening_date: new Date(),
        allow_negative: false,
        archived: false,
      },
    });

    const res = await request(app.getHttpServer())
      .get('/dashboard/balances')
      .set('Cookie', userAHeaders.cookie);

    expect(res.status).toBe(200);
    expect(res.body.ledger_balance).toBe(3250000); // 2.950.000 + 300.000
    expect(res.body.reserved_total).toBe(400000);
    expect(res.body.available_balance).toBe(550000); // tetap 550.000
    expect(res.body.net_worth).toBe(3300000); // 3.000.000 + 300.000
    expect(res.body.accounts_count).toBe(4);
  });

  it('AC-3: available_balance bernilai negatif bila reserved_total > saldo likuid (tidak di-clamp)', async () => {
    const bca = await prisma.asSystem().account.findFirstOrThrow({
      where: { user_id: userAId, name: 'BCA' },
    });
    const goal = await prisma.asSystem().savingsGoal.findFirstOrThrow({
      where: { user_id: userAId, name: 'Dana Darurat' },
    });

    // Tambah alokasi 1.000.000 sehingga total reserved = 1.400.000
    // Saldo likuid = BCA (1.000.000) + Dompet (-50.000) = 950.000
    // available_balance = 950.000 - 1.400.000 = -450.000
    const extraAlloc = await prisma.asSystem().savingsAllocation.create({
      data: {
        savings_goal_id: goal.id,
        account_id: bca.id,
        amount: 1000000n,
        status: 'ACTIVE',
      },
    });

    const res = await request(app.getHttpServer())
      .get('/dashboard/balances')
      .set('Cookie', userAHeaders.cookie);

    expect(res.status).toBe(200);
    expect(res.body.reserved_total).toBe(1400000);
    expect(res.body.available_balance).toBe(-450000);

    // Hapus kembali alokasi extra untuk test berikutnya
    await prisma.asSystem().savingsAllocation.delete({
      where: { id: extraAlloc.id },
    });
  });

  it('AC-4: Membuat/melepas alokasi tabungan tidak mengubah ledger_balance maupun net_worth (ADR-007)', async () => {
    const beforeRes = await request(app.getHttpServer())
      .get('/dashboard/balances')
      .set('Cookie', userAHeaders.cookie);

    const bca = await prisma.asSystem().account.findFirstOrThrow({
      where: { user_id: userAId, name: 'BCA' },
    });
    const goal = await prisma.asSystem().savingsGoal.findFirstOrThrow({
      where: { user_id: userAId, name: 'Dana Darurat' },
    });

    const alloc = await prisma.asSystem().savingsAllocation.create({
      data: {
        savings_goal_id: goal.id,
        account_id: bca.id,
        amount: 200000n,
        status: 'ACTIVE',
      },
    });

    const duringRes = await request(app.getHttpServer())
      .get('/dashboard/balances')
      .set('Cookie', userAHeaders.cookie);

    // ledger_balance & net_worth tidak berubah
    expect(duringRes.body.ledger_balance).toBe(beforeRes.body.ledger_balance);
    expect(duringRes.body.net_worth).toBe(beforeRes.body.net_worth);
    // reserved bertambah, available berkurang
    expect(duringRes.body.reserved_total).toBe(beforeRes.body.reserved_total + 200000);
    expect(duringRes.body.available_balance).toBe(beforeRes.body.available_balance - 200000);

    // Lepas alokasi (status RELEASED)
    await prisma.asSystem().savingsAllocation.update({
      where: { id: alloc.id },
      data: { status: 'RELEASED' },
    });

    const afterRes = await request(app.getHttpServer())
      .get('/dashboard/balances')
      .set('Cookie', userAHeaders.cookie);

    expect(afterRes.body.ledger_balance).toBe(beforeRes.body.ledger_balance);
    expect(afterRes.body.net_worth).toBe(beforeRes.body.net_worth);
    expect(afterRes.body.reserved_total).toBe(beforeRes.body.reserved_total);
    expect(afterRes.body.available_balance).toBe(beforeRes.body.available_balance);
  });

  it('AC-5: Akun & alokasi user lain tidak pernah ikut terhitung (C-01); tanpa cookie -> 401', async () => {
    // Seed akun untuk User B
    await prisma.asSystem().account.create({
      data: {
        user_id: userBId,
        financial_profile_id: profileBId,
        name: 'Mandiri User B',
        type: 'BANK',
        opening_balance: 777000n,
        balance: 777000n,
        opening_date: new Date(),
      },
    });

    // Request dengan user B
    const resB = await request(app.getHttpServer())
      .get('/dashboard/balances')
      .set('Cookie', userBHeaders.cookie);

    expect(resB.status).toBe(200);
    expect(resB.body.ledger_balance).toBe(777000);
    expect(resB.body.available_balance).toBe(777000);
    expect(resB.body.net_worth).toBe(777000);
    expect(resB.body.accounts_count).toBe(1);

    // Request tanpa sesi -> 401
    const resNoAuth = await request(app.getHttpServer()).get('/dashboard/balances');
    expect(resNoAuth.status).toBe(401);
  });

  describe('TASK-081: GET /dashboard/summary & GET /dashboard/cash-flow', () => {
    let bcaAccountId: string;
    let walletAccountId: string;

    beforeAll(async () => {
      // Ambil ID akun BCA dan Dompet milik user A
      const bca = await prisma.asSystem().account.findFirstOrThrow({
        where: { user_id: userAId, name: 'BCA' },
      });
      bcaAccountId = bca.id;

      const wallet = await prisma.asSystem().account.findFirstOrThrow({
        where: { user_id: userAId, name: 'Dompet' },
      });
      walletAccountId = wallet.id;
    });

    it('AC-1: Ringkasan November dengan INCOME, EXPENSE, TRANSFER Metode A fee terpisah, dan ADJUSTMENT', async () => {
      // Bersihkan transaksi sebelumnya
      await prisma.asSystem().transactionSplit.deleteMany();
      await prisma.asSystem().transaction.deleteMany();

      // 1. INCOME 5.000.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'INCOME',
          amount: 5000000n,
          date: new Date('2026-11-05T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-inc-1',
        },
      });

      // 2. EXPENSE 1.200.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 1200000n,
          date: new Date('2026-11-06T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-exp-1',
        },
      });

      // 3. TRANSFER 500.000 Metode A fee 6.500 (TRANSFER row + EXPENSE fee row)
      const trfGroupId = randomUUID();
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          to_account_id: walletAccountId,
          type: 'TRANSFER',
          amount: 500000n,
          date: new Date('2026-11-07T00:00:00.000Z'),
          status: 'POSTED',
          transfer_group_id: trfGroupId,
          transfer_fee: 6500n,
          fee_mode: 'SEPARATE',
          client_tx_id: 'tx-trf-1',
        },
      });
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 6500n,
          date: new Date('2026-11-07T00:00:00.000Z'),
          status: 'POSTED',
          transfer_group_id: trfGroupId,
          client_tx_id: 'tx-trf-1-fee',
        },
      });

      // 4. ADJUSTMENT -20.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'ADJUSTMENT',
          amount: -20000n,
          date: new Date('2026-11-08T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-adj-1',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        from: '2026-11-01',
        to: '2026-11-30',
        income: 5000000,
        expense: 1206500,
        net: 3793500,
        adjustment_net: -20000,
        transfer_total: 500000,
      });
    });

    it('AC-2 (C-04): Transaksi SCHEDULED tidak ikut terhitung; ikut terhitung setelah POSTED', async () => {
      const scheduledTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-15T00:00:00.000Z'),
          status: 'SCHEDULED',
          client_tx_id: 'tx-sched-1',
        },
      });

      const beforeRes = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(beforeRes.body.expense).toBe(1206500);

      // Ubah jadi POSTED
      await prisma.asSystem().transaction.update({
        where: { id: scheduledTx.id },
        data: { status: 'POSTED' },
      });

      const afterRes = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(afterRes.body.expense).toBe(1256500);

      // Bersihkan tx ini
      await prisma.asSystem().transaction.delete({ where: { id: scheduledTx.id } });
    });

    it('AC-3 (C-05): Transaksi yang di-reverse tidak terhitung; reversal transfer Metode A menghapus fee', async () => {
      // EXPENSE 100.000 yang di-reverse
      const originalExpense = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 100000n,
          date: new Date('2026-11-10T00:00:00.000Z'),
          status: 'REVERSED',
          client_tx_id: 'tx-rev-exp-orig',
        },
      });
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'REVERSAL',
          amount: 100000n,
          date: new Date('2026-11-10T00:00:00.000Z'),
          status: 'POSTED',
          parent_transaction_id: originalExpense.id,
          client_tx_id: 'tx-rev-exp-reversal',
        },
      });

      // Reverse transfer Metode A dan feenya
      const feeTx = await prisma.asSystem().transaction.findFirstOrThrow({
        where: { client_tx_id: 'tx-trf-1-fee' },
      });
      await prisma.asSystem().transaction.update({
        where: { id: feeTx.id },
        data: { status: 'REVERSED' },
      });
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'REVERSAL',
          amount: 6500n,
          date: new Date('2026-11-07T00:00:00.000Z'),
          status: 'POSTED',
          parent_transaction_id: feeTx.id,
          client_tx_id: 'tx-trf-1-fee-reversal',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);

      // 100.000 tidak masuk, dan fee 6.500 telah di-reverse sehingga expense kembali 1.200.000
      expect(res.body.expense).toBe(1200000);
      expect(res.body.net).toBe(3800000);
    });

    it('AC-4: Transfer Metode B (bundled) tidak menambah expense', async () => {
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          to_account_id: walletAccountId,
          type: 'TRANSFER',
          amount: 493500n,
          transfer_fee: 6500n,
          fee_mode: 'BUNDLED',
          date: new Date('2026-11-12T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-trf-bundled',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);

      // Expense tetap 1.200.000
      expect(res.body.expense).toBe(1200000);
      expect(res.body.transfer_total).toBe(993500); // 500.000 + 493.500
    });

    it('AC-5: Default periode tanpa query adalah awal s.d. akhir bulan berjalan user', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/summary')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.from).toMatch(/^\d{4}-\d{2}-01$/);
      expect(res.body.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.body.from <= res.body.to).toBe(true);
    });

    it('AC-6: Filter category_id dengan rollup 1 level & split-aware, serta filter account_id', async () => {
      const parentCat = await prisma.asSystem().category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Makanan',
          type: 'EXPENSE',
        },
      });

      const childCat = await prisma.asSystem().category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          parent_id: parentCat.id,
          name: 'Restoran',
          type: 'EXPENSE',
        },
      });

      const otherCat = await prisma.asSystem().category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Transportasi',
          type: 'EXPENSE',
        },
      });

      // Buat transaksi split (Restoran 30.000 + Transport 20.000)
      const splitTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: walletAccountId,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-11-20T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-split-cat',
        },
      });

      await prisma.asSystem().transactionSplit.createMany({
        data: [
          {
            transaction_id: splitTx.id,
            category_id: childCat.id,
            amount: 30000n,
          },
          {
            transaction_id: splitTx.id,
            category_id: otherCat.id,
            amount: 20000n,
          },
        ],
      });

      // Test via DashboardService.getSummary langsung dengan category_id = [parentCat.id]
      const catSummary = await dashboardService.getSummary(userAId, {
        from: '2026-11-01',
        to: '2026-11-30',
        category_id: [parentCat.id],
      });
      // Hanya menghitung anak kategori Makanan (Restoran: 30.000)
      expect(catSummary.expense).toBe(30000);
      expect(catSummary.adjustment_net).toBe(0);
      expect(catSummary.transfer_total).toBe(0);

      // Test dengan account_id = [walletAccountId]
      const accSummary = await dashboardService.getSummary(userAId, {
        from: '2026-11-01',
        to: '2026-11-30',
        account_id: [walletAccountId],
      });
      // walletAccount menerima transfer (500k + 493.5k) dan splitTx 50k
      expect(accSummary.expense).toBe(50000);
      expect(accSummary.transfer_total).toBe(993500);
    });

    it('AC-7: GET /dashboard/cash-flow?months=3 mengembalikan 3 item urut naik dan bulan kosong bernilai 0', async () => {
      const res = await request(app.getHttpServer())
        .get('/dashboard/cash-flow?months=3')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBe(3);

      const items = res.body.items;
      expect(items[0].month < items[1].month).toBe(true);
      expect(items[1].month < items[2].month).toBe(true);

      for (const item of items) {
        expect(typeof item.income).toBe('number');
        expect(typeof item.expense).toBe('number');
        expect(typeof item.net).toBe('number');
        expect(item.net).toBe(item.income - item.expense);
      }
    });

    it('AC-8: Validasi from > to -> 400, rentang > 366 hari -> 400 DATE_RANGE_TOO_LARGE, dan isolasi user (C-01)', async () => {
      // from > to
      const resInvalid = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-30&to=2026-11-01')
        .set('Cookie', userAHeaders.cookie);
      expect(resInvalid.status).toBe(400);

      // Rentang > 366 hari
      const resTooLarge = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2025-01-01&to=2026-03-01')
        .set('Cookie', userAHeaders.cookie);
      expect(resTooLarge.status).toBe(400);
      expect(resTooLarge.body.code).toBe('DATE_RANGE_TOO_LARGE');

      // User B tidak melihat data user A
      const resUserB = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userBHeaders.cookie);
      expect(resUserB.status).toBe(200);
      expect(resUserB.body.income).toBe(0);
      expect(resUserB.body.expense).toBe(0);
      expect(resUserB.body.net).toBe(0);

      // Tanpa auth
      const resNoAuthSummary = await request(app.getHttpServer()).get('/dashboard/summary');
      expect(resNoAuthSummary.status).toBe(401);

      const resNoAuthCashFlow = await request(app.getHttpServer()).get('/dashboard/cash-flow');
      expect(resNoAuthCashFlow.status).toBe(401);

      const resNoAuthCategories = await request(app.getHttpServer()).get('/dashboard/categories');
      expect(resNoAuthCategories.status).toBe(401);
    });

    it('AC-1 to AC-7: GET /dashboard/categories returns rollup items, split-aware, obeys C-07 invariant with summary', async () => {
      // Create an archived category with an expense
      const archivedCat = await prisma.asSystem().category.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Langganan Lama',
          type: 'EXPENSE',
          archived: true,
          archived_at: new Date(),
        },
      });

      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: walletAccountId,
          type: 'EXPENSE',
          category_id: archivedCat.id,
          amount: 25000n,
          date: new Date('2026-11-22T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-archived-cat',
        },
      });

      // Call GET /dashboard/summary
      const summaryRes = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(summaryRes.status).toBe(200);

      // Call GET /dashboard/categories
      const catRes = await request(app.getHttpServer())
        .get('/dashboard/categories?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);

      expect(catRes.status).toBe(200);
      expect(catRes.body.from).toBe('2026-11-01');
      expect(catRes.body.to).toBe('2026-11-30');
      expect(Array.isArray(catRes.body.items)).toBe(true);

      // AC-3: C-07 invariant
      const itemsSum = catRes.body.items.reduce((sum: number, it: any) => sum + it.amount, 0);
      expect(itemsSum).toBe(catRes.body.total);
      expect(catRes.body.total).toBe(summaryRes.body.expense);

      // Check percentage integer basis points sum <= 10000
      let totalBp = 0;
      for (const item of catRes.body.items) {
        expect(typeof item.percent_bp).toBe('number');
        expect(Number.isInteger(item.percent_bp)).toBe(true);
        totalBp += item.percent_bp;
      }
      expect(totalBp).toBeLessThanOrEqual(10000);

      // AC-1: Rollup 1 level check (child category 'Restoran' rolled up to 'Makanan')
      const makananItem = catRes.body.items.find((it: any) => it.name === 'Makanan');
      expect(makananItem).toBeDefined();
      expect(makananItem.amount).toBeGreaterThanOrEqual(30000);

      // AC-5: Archived category check
      const archivedItem = catRes.body.items.find((it: any) => it.name === 'Langganan Lama');
      expect(archivedItem).toBeDefined();
      expect(archivedItem.archived).toBe(true);
      expect(archivedItem.amount).toBe(25000);

      // Items sorted by amount desc, name asc
      for (let i = 0; i < catRes.body.items.length - 1; i++) {
        const cur = catRes.body.items[i];
        const next = catRes.body.items[i + 1];
        if (cur.amount === next.amount) {
          expect(cur.name.localeCompare(next.name)).toBeLessThanOrEqual(0);
        } else {
          expect(cur.amount).toBeGreaterThan(next.amount);
        }
      }

      // AC-7: Empty period -> total: 0, items: []
      const emptyRes = await request(app.getHttpServer())
        .get('/dashboard/categories?from=2024-01-01&to=2024-01-31')
        .set('Cookie', userAHeaders.cookie);
      expect(emptyRes.status).toBe(200);
      expect(emptyRes.body.total).toBe(0);
      expect(emptyRes.body.items).toEqual([]);

      // User B isolation (C-01)
      const userBRes = await request(app.getHttpServer())
        .get('/dashboard/categories?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userBHeaders.cookie);
      expect(userBRes.status).toBe(200);
      expect(userBRes.body.total).toBe(0);
      expect(userBRes.body.items).toEqual([]);

      // Validation tests
      const resInvalid = await request(app.getHttpServer())
        .get('/dashboard/categories?from=2026-11-30&to=2026-11-01')
        .set('Cookie', userAHeaders.cookie);
      expect(resInvalid.status).toBe(400);

      const resTooLarge = await request(app.getHttpServer())
        .get('/dashboard/categories?from=2025-01-01&to=2026-03-01')
        .set('Cookie', userAHeaders.cookie);
      expect(resTooLarge.status).toBe(400);
      expect(resTooLarge.body.code).toBe('DATE_RANGE_TOO_LARGE');
    });
  });

  describe('TASK-083: GET /dashboard/balance-trend', () => {
    let bcaAccountId: string;
    let walletAccountId: string;
    let userATz: string;
    let todayStr: string;

    beforeAll(async () => {
      // Bersihkan data lama
      await prisma.asSystem().transactionSplit.deleteMany();
      await prisma.asSystem().transaction.deleteMany();
      await prisma.asSystem().savingsAllocation.deleteMany();
      await prisma.asSystem().savingsGoal.deleteMany();
      await prisma.asSystem().account.deleteMany();

      const pref = await prisma.userPreference.findFirst({
        where: { user_id: userAId },
      });
      userATz = pref?.timezone ?? 'Asia/Jakarta';
      todayStr = todayInTz(userATz);

      // Buat akun untuk User A
      const bca = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'BCA Trend',
          type: 'BANK',
          opening_balance: 1000000n,
          opening_date: new Date('2026-01-01T00:00:00.000Z'),
          balance: 1000000n,
        },
      });
      bcaAccountId = bca.id;

      const wallet = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Dompet Trend',
          type: 'CASH',
          opening_balance: 200000n,
          opening_date: new Date('2026-01-01T00:00:00.000Z'),
          balance: 200000n,
        },
      });
      walletAccountId = wallet.id;

      // Akun terarsip User A (tidak boleh ikut terhitung di ledger_balance / trend)
      await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Archived Account',
          type: 'BANK',
          opening_balance: 500000n,
          opening_date: new Date('2026-01-01T00:00:00.000Z'),
          balance: 500000n,
          archived: true,
          archived_at: new Date(),
        },
      });
    });

    it('AC-2 (Invarian): Setelah serangkaian income, expense, transfer A & B, adjustment, dan reversal, titik terakhir (to = hari ini) === GET /dashboard/balances .ledger_balance', async () => {
      // 1. INCOME di BCA 500.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'INCOME',
          amount: 500000n,
          date: new Date(`${todayStr}T00:00:00.000Z`),
          status: 'POSTED',
          client_tx_id: 'trend-income-1',
        },
      });

      // 2. EXPENSE di Dompet 50.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: walletAccountId,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date(`${todayStr}T00:00:00.000Z`),
          status: 'POSTED',
          client_tx_id: 'trend-expense-1',
        },
      });

      // 3. TRANSFER Metode A (BCA -> Dompet 100.000 dengan fee terpisah 6.500)
      const groupAId = randomUUID();
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          to_account_id: walletAccountId,
          type: 'TRANSFER',
          amount: 100000n,
          date: new Date(`${todayStr}T00:00:00.000Z`),
          status: 'POSTED',
          transfer_group_id: groupAId,
          client_tx_id: 'trend-transfer-a-main',
        },
      });
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 6500n,
          date: new Date(`${todayStr}T00:00:00.000Z`),
          status: 'POSTED',
          transfer_group_id: groupAId,
          client_tx_id: 'trend-transfer-a-fee',
        },
      });

      // 4. TRANSFER Metode B (Dompet -> BCA 50.000, fee 2.500 BUNDLED)
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: walletAccountId,
          to_account_id: bcaAccountId,
          type: 'TRANSFER',
          amount: 50000n,
          transfer_fee: 2500n,
          fee_mode: 'BUNDLED',
          date: new Date(`${todayStr}T00:00:00.000Z`),
          status: 'POSTED',
          client_tx_id: 'trend-transfer-b',
        },
      });

      // 5. ADJUSTMENT di BCA +20.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'ADJUSTMENT',
          amount: 20000n,
          date: new Date(`${todayStr}T00:00:00.000Z`),
          status: 'POSTED',
          client_tx_id: 'trend-adj-1',
        },
      });

      // 6. Transaksi yang di-reverse: EXPENSE 30.000 lalu REVERSAL
      const expToReverse = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 30000n,
          date: new Date(`${todayStr}T00:00:00.000Z`),
          status: 'REVERSED',
          client_tx_id: 'trend-exp-to-reverse',
        },
      });
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'REVERSAL',
          parent_transaction_id: expToReverse.id,
          amount: 30000n,
          date: new Date(`${todayStr}T00:00:00.000Z`),
          status: 'POSTED',
          client_tx_id: 'trend-exp-reversal',
        },
      });

      // Sinkronkan Account.balance agar konsisten dengan seluruh transaksi di atas
      // BCA: 1.000.000 + 500.000 (inc) - 100.000 (trf A) - 6.500 (fee A) + 50.000 (trf B) + 20.000 (adj) = 1.463.500
      // Dompet: 200.000 - 50.000 (exp) + 100.000 (trf A) - 52.500 (trf B + bundled fee) = 197.500
      // Total ledger_balance = 1.463.500 + 197.500 = 1.661.000
      await prisma.asSystem().account.update({
        where: { id: bcaAccountId },
        data: { balance: 1463500n },
      });
      await prisma.asSystem().account.update({
        where: { id: walletAccountId },
        data: { balance: 197500n },
      });

      // Panggil GET /dashboard/balances
      const balancesRes = await request(app.getHttpServer())
        .get('/dashboard/balances')
        .set('Cookie', userAHeaders.cookie);
      expect(balancesRes.status).toBe(200);
      expect(balancesRes.body.ledger_balance).toBe(1661000);

      // Panggil GET /dashboard/balance-trend?to=<today>
      const trendRes = await request(app.getHttpServer())
        .get(`/dashboard/balance-trend?to=${todayStr}`)
        .set('Cookie', userAHeaders.cookie);
      expect(trendRes.status).toBe(200);

      const lastPoint = trendRes.body.points[trendRes.body.points.length - 1];
      expect(lastPoint.date).toBe(todayStr);
      expect(lastPoint.ledger_balance).toBe(balancesRes.body.ledger_balance);
    });

    it('AC-3: Akun dengan opening_date setelah D tidak berkontribusi pada titik D', async () => {
      // Buat akun baru dengan opening_date 2026-11-05 bernilai 300.000
      const newAcc = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          name: 'Akun Tengah Bulan',
          type: 'BANK',
          opening_balance: 300000n,
          opening_date: new Date('2026-11-05T00:00:00.000Z'),
          balance: 300000n,
        },
      });

      const res = await request(app.getHttpServer())
        .get('/dashboard/balance-trend?from=2026-11-01&to=2026-11-10')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.points.length).toBe(10);

      const p4 = res.body.points.find((p: any) => p.date === '2026-11-04');
      const p5 = res.body.points.find((p: any) => p.date === '2026-11-05');
      expect(p4).toBeDefined();
      expect(p5).toBeDefined();

      // Selisih antara tanggal 4 dan tanggal 5 harus tepat 300.000
      expect(p5.ledger_balance - p4.ledger_balance).toBe(300000);

      // Hapus akun test agar tidak mempengaruhi test berikutnya
      await prisma.asSystem().account.delete({ where: { id: newAcc.id } });
    });

    it('AC-4 (C-05): Expense 100.000 tanggal 5 yang di-reverse tanggal 10 -> titik 5-9 turun 100.000, titik >= 10 kembali normal', async () => {
      const expTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 100000n,
          date: new Date('2026-11-05T00:00:00.000Z'),
          status: 'REVERSED',
          client_tx_id: 'trend-c05-exp',
        },
      });

      const revTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'REVERSAL',
          parent_transaction_id: expTx.id,
          amount: 100000n,
          date: new Date('2026-11-10T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'trend-c05-rev',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/dashboard/balance-trend?from=2026-11-01&to=2026-11-15')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);

      const baselinePoint = res.body.points.find((p: any) => p.date === '2026-11-04');
      const dippedPoint5 = res.body.points.find((p: any) => p.date === '2026-11-05');
      const dippedPoint9 = res.body.points.find((p: any) => p.date === '2026-11-09');
      const recoveredPoint10 = res.body.points.find((p: any) => p.date === '2026-11-10');

      expect(baselinePoint.ledger_balance - dippedPoint5.ledger_balance).toBe(100000);
      expect(dippedPoint5.ledger_balance).toBe(dippedPoint9.ledger_balance);
      expect(recoveredPoint10.ledger_balance).toBe(baselinePoint.ledger_balance);

      await prisma.asSystem().transaction.delete({ where: { id: revTx.id } });
      await prisma.asSystem().transaction.delete({ where: { id: expTx.id } });
    });

    it('AC-5: Transaksi SCHEDULED bertanggal masa depan tidak mengubah titik mana pun', async () => {
      const resBefore = await request(app.getHttpServer())
        .get('/dashboard/balance-trend?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(resBefore.status).toBe(200);

      const scheduledTx = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'INCOME',
          amount: 9999999n,
          date: new Date('2026-11-20T00:00:00.000Z'),
          status: 'SCHEDULED',
          client_tx_id: 'trend-scheduled-future',
        },
      });

      const resAfter = await request(app.getHttpServer())
        .get('/dashboard/balance-trend?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(resAfter.status).toBe(200);

      expect(resAfter.body.points).toEqual(resBefore.body.points);

      await prisma.asSystem().transaction.delete({ where: { id: scheduledTx.id } });
    });

    it('AC-6: Rentang 30 hari -> 30 titik "day"; rentang 12 bulan -> titik akhir bulan "month" dengan titik terakhir = to', async () => {
      // 30 hari
      const res30 = await request(app.getHttpServer())
        .get('/dashboard/balance-trend?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(res30.status).toBe(200);
      expect(res30.body.granularity).toBe('day');
      expect(res30.body.points.length).toBe(30);
      expect(res30.body.points[0].date).toBe('2026-11-01');
      expect(res30.body.points[29].date).toBe('2026-11-30');

      // 12 bulan (365 hari)
      const res12m = await request(app.getHttpServer())
        .get('/dashboard/balance-trend?from=2026-01-01&to=2026-12-31')
        .set('Cookie', userAHeaders.cookie);
      expect(res12m.status).toBe(200);
      expect(res12m.body.granularity).toBe('month');
      expect(res12m.body.points.length).toBe(12);
      expect(res12m.body.points[0].date).toBe('2026-01-31');
      expect(res12m.body.points[1].date).toBe('2026-02-28');
      expect(res12m.body.points[11].date).toBe('2026-12-31');
    });

    it('AC-7: Data user lain tidak ikut (C-01); validasi error & 401', async () => {
      // 1. User B tanpa data saldo
      const resUserB = await request(app.getHttpServer())
        .get('/dashboard/balance-trend?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userBHeaders.cookie);
      expect(resUserB.status).toBe(200);
      expect(resUserB.body.points.length).toBe(30);
      for (const p of resUserB.body.points) {
        expect(p.ledger_balance).toBe(0);
      }

      // 2. Tanpa auth -> 401
      const resNoAuth = await request(app.getHttpServer()).get('/dashboard/balance-trend');
      expect(resNoAuth.status).toBe(401);

      // 3. from > to -> 400
      const resInvalid = await request(app.getHttpServer())
        .get('/dashboard/balance-trend?from=2026-11-30&to=2026-11-01')
        .set('Cookie', userAHeaders.cookie);
      expect(resInvalid.status).toBe(400);

      // 4. Rentang > 366 hari -> 400 DATE_RANGE_TOO_LARGE
      const resTooLarge = await request(app.getHttpServer())
        .get('/dashboard/balance-trend?from=2025-01-01&to=2026-03-01')
        .set('Cookie', userAHeaders.cookie);
      expect(resTooLarge.status).toBe(400);
      expect(resTooLarge.body.code).toBe('DATE_RANGE_TOO_LARGE');
    });
  });
});
