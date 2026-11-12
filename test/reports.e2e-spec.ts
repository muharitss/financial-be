import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TransactionsService } from '../src/modules/transactions/transactions.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { todayInTz } from '../src/common/utils/date.js';

describe('Reports E2E Test Suite (Supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let userAHeaders: { cookie: string };
  let userBHeaders: { cookie: string };

  let userAId: string;
  let userBId: string;
  let profileAId: string;
  let profileBId: string;

  let bcaAccountId: string;
  let dompetAccountId: string;
  let userBAccountId: string;

  let makananCatId: string;
  let restoranCatId: string;
  let transportCatId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new AllExceptionsFilter());

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Duitku API')
      .setVersion('0.1')
      .addCookieAuth('__Host-duitku_session')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);

    await app.init();

    prisma = app.get(PrismaService);

    // Bersihkan test data
    await prisma.asSystem().notification.deleteMany();
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.asSystem().savingsGoal.deleteMany();
    await prisma.asSystem().transactionSplit.deleteMany();
    await prisma.asSystem().transaction.deleteMany();
    await prisma.asSystem().category.deleteMany();
    await prisma.asSystem().account.deleteMany();
    await prisma.user.deleteMany({
      where: {
        email: { endsWith: '@reports-test.duitku' },
      },
    });

    // Registrasi User A
    const resA = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-a@reports-test.duitku',
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
        email: 'user-b@reports-test.duitku',
        password: 'Password123!',
        name: 'User B',
      });
    expect(resB.status).toBe(201);
    userBId = resB.body.user.id;
    const cookieB = resB.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userBHeaders = { cookie: cookieB };

    const profileA = await prisma.asSystem().financialProfile.findFirstOrThrow({
      where: { user_id: userAId, is_default: true },
    });
    profileAId = profileA.id;

    const profileB = await prisma.asSystem().financialProfile.findFirstOrThrow({
      where: { user_id: userBId, is_default: true },
    });
    profileBId = profileB.id;

    // Buat akun User A
    const bca = await prisma.asSystem().account.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'BCA',
        type: 'BANK',
        opening_balance: 10_000_000n,
        balance: 10_000_000n,
        opening_date: new Date('2026-01-01T00:00:00.000Z'),
        allow_negative: false,
        archived: false,
      },
    });
    bcaAccountId = bca.id;

    const dompet = await prisma.asSystem().account.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Dompet',
        type: 'CASH',
        opening_balance: 1_000_000n,
        balance: 1_000_000n,
        opening_date: new Date('2026-01-01T00:00:00.000Z'),
        allow_negative: true,
        archived: false,
      },
    });
    dompetAccountId = dompet.id;

    // Buat akun User B
    const userBAccount = await prisma.asSystem().account.create({
      data: {
        user_id: userBId,
        financial_profile_id: profileBId,
        name: 'Mandiri B',
        type: 'BANK',
        opening_balance: 5_000_000n,
        balance: 5_000_000n,
        opening_date: new Date('2026-01-01T00:00:00.000Z'),
        allow_negative: false,
        archived: false,
      },
    });
    userBAccountId = userBAccount.id;

    // Buat kategori User A
    const parentMakanan = await prisma.asSystem().category.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Makanan & Minuman',
        type: 'EXPENSE',
      },
    });
    makananCatId = parentMakanan.id;

    const childRestoran = await prisma.asSystem().category.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Restoran',
        type: 'EXPENSE',
        parent_id: makananCatId,
      },
    });
    restoranCatId = childRestoran.id;

    const transport = await prisma.asSystem().category.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Transportasi',
        type: 'EXPENSE',
      },
    });
    transportCatId = transport.id;
  });

  afterAll(async () => {
    await app.close();
  }, 30000);

  describe('AC-1 & AC-8: GET /reports/summary', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app.getHttpServer()).get('/reports/summary');
      expect(res.status).toBe(401);
    });

    it('filters by account_id and matches dashboard/summary when unfiltered', async () => {
      await prisma.asSystem().transactionSplit.deleteMany();
      await prisma.asSystem().transaction.deleteMany();

      // Transaksi BCA: Income 5.000.000, Expense 1.000.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'INCOME',
          amount: 5_000_000n,
          date: new Date('2026-11-05T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-inc-bca',
        },
      });

      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 1_000_000n,
          category_id: makananCatId,
          date: new Date('2026-11-06T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-exp-bca',
        },
      });

      // Transaksi Dompet: Expense 200.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: dompetAccountId,
          type: 'EXPENSE',
          amount: 200_000n,
          category_id: transportCatId,
          date: new Date('2026-11-07T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-exp-dompet',
        },
      });

      // Filter BCA only: income = 5M, expense = 1M, net = 4M
      const resBca = await request(app.getHttpServer())
        .get(`/reports/summary?from=2026-11-01&to=2026-11-30&account_id=${bcaAccountId}`)
        .set('Cookie', userAHeaders.cookie);

      expect(resBca.status).toBe(200);
      expect(resBca.body.income).toBe(5_000_000);
      expect(resBca.body.expense).toBe(1_000_000);
      expect(resBca.body.net).toBe(4_000_000);

      // Tanpa filter: identik dengan GET /dashboard/summary
      const resReport = await request(app.getHttpServer())
        .get('/reports/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);

      const resDashboard = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);

      expect(resReport.status).toBe(200);
      expect(resDashboard.status).toBe(200);
      expect(resReport.body).toEqual(resDashboard.body);
      expect(resReport.body.expense).toBe(1_200_000);
    });

    it('AC-8: account_id of another user returns 0 data without leaking', async () => {
      const res = await request(app.getHttpServer())
        .get(`/reports/summary?from=2026-11-01&to=2026-11-30&account_id=${userBAccountId}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.income).toBe(0);
      expect(res.body.expense).toBe(0);
      expect(res.body.net).toBe(0);

      // User B request gets User B's empty summary
      const resB = await request(app.getHttpServer())
        .get('/reports/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userBHeaders.cookie);
      expect(resB.status).toBe(200);
      expect(resB.body.income).toBe(0);
      expect(resB.body.expense).toBe(0);
    });
  });

  describe('AC-2: GET /reports/categories', () => {
    it('rolls up subcategories into parent category and satisfies sum(items) === total', async () => {
      await prisma.asSystem().transactionSplit.deleteMany();
      await prisma.asSystem().transaction.deleteMany();

      // Transaksi di subkategori Restoran (anak dari Makanan)
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 500_000n,
          category_id: restoranCatId,
          date: new Date('2026-11-05T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-resto',
        },
      });

      // Transaksi di kategori induk Makanan
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 300_000n,
          category_id: makananCatId,
          date: new Date('2026-11-06T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-makanan',
        },
      });

      // Transaksi di kategori Transportasi
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 200_000n,
          category_id: transportCatId,
          date: new Date('2026-11-07T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-transport',
        },
      });

      // Filter by category_id = Makanan (induk)
      const res = await request(app.getHttpServer())
        .get(`/reports/categories?from=2026-11-01&to=2026-11-30&category_id=${makananCatId}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(800_000); // 500k + 300k
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].category_id).toBe(makananCatId);
      expect(res.body.items[0].amount).toBe(800_000);
      const sumItems = res.body.items.reduce((s: number, i: any) => s + i.amount, 0);
      expect(sumItems).toBe(res.body.total);
    });
  });

  describe('AC-3: GET /reports/balance-changes', () => {
    it('satisfies closing - opening === inflow - outflow, and totals.closing === ledger_balance when to=today', async () => {
      await prisma.asSystem().transactionSplit.deleteMany();
      await prisma.asSystem().transaction.deleteMany();

      const today = todayInTz('Asia/Jakarta');

      // Reset balance on accounts
      await prisma.asSystem().account.update({
        where: { id: bcaAccountId },
        data: { balance: 10_000_000n },
      });
      await prisma.asSystem().account.update({
        where: { id: dompetAccountId },
        data: { balance: 1_000_000n },
      });

      // Buat transaksi hari ini
      // BCA: +2.000.000 income
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'INCOME',
          amount: 2_000_000n,
          date: new Date(`${today}T00:00:00.000Z`),
          status: 'POSTED',
          client_tx_id: 'tx-bal-inc',
        },
      });
      await prisma.asSystem().account.update({
        where: { id: bcaAccountId },
        data: { balance: 12_000_000n },
      });

      // Transfer: 500.000 from BCA to Dompet
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          to_account_id: dompetAccountId,
          type: 'TRANSFER',
          amount: 500_000n,
          date: new Date(`${today}T00:00:00.000Z`),
          status: 'POSTED',
          client_tx_id: 'tx-bal-trf',
        },
      });
      await prisma.asSystem().account.update({
        where: { id: bcaAccountId },
        data: { balance: 11_500_000n },
      });
      await prisma.asSystem().account.update({
        where: { id: dompetAccountId },
        data: { balance: 1_500_000n },
      });

      // Ambil balance-changes dari awal (2026-01-01) sampai hari ini
      const res = await request(app.getHttpServer())
        .get(`/reports/balance-changes?from=2026-01-01&to=${today}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);

      for (const item of res.body.items) {
        expect(item.closing - item.opening).toBe(item.inflow - item.outflow);
        if (item.account_id === bcaAccountId) {
          expect(item.closing).toBe(11_500_000);
        } else if (item.account_id === dompetAccountId) {
          expect(item.closing).toBe(1_500_000);
        }
      }

      // Verifikasi totals.closing === GET /dashboard/balances ledger_balance
      const balRes = await request(app.getHttpServer())
        .get('/dashboard/balances')
        .set('Cookie', userAHeaders.cookie);

      expect(balRes.status).toBe(200);
      expect(res.body.totals.closing).toBe(balRes.body.ledger_balance);
      expect(res.body.totals.closing - res.body.totals.opening).toBe(
        res.body.totals.inflow - res.body.totals.outflow,
      );
    });
  });

  describe('AC-4: GET /reports/monthly-comparison', () => {
    it('computes comparison deltas and delta_bp properly (Oktober 1M, November 1.25M -> delta 250k, delta_bp 2500)', async () => {
      await prisma.asSystem().transactionSplit.deleteMany();
      await prisma.asSystem().transaction.deleteMany();

      // Oktober: Expense 1.000.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 1_000_000n,
          category_id: makananCatId,
          date: new Date('2026-10-15T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-oct-exp',
        },
      });

      // November: Expense 1.250.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 1_250_000n,
          category_id: makananCatId,
          date: new Date('2026-11-15T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-nov-exp',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/reports/monthly-comparison?month=2026-11')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.month).toBe('2026-11');
      expect(res.body.previous_month).toBe('2026-10');
      expect(res.body.current.expense).toBe(1_250_000);
      expect(res.body.previous.expense).toBe(1_000_000);
      expect(res.body.delta.expense).toBe(250_000);
      expect(res.body.delta_bp.expense).toBe(2500);

      // Categories
      expect(res.body.categories.length).toBeGreaterThanOrEqual(1);
      const makanan = res.body.categories.find((c: any) => c.category_id === makananCatId);
      expect(makanan).toBeDefined();
      expect(makanan.current).toBe(1_250_000);
      expect(makanan.previous).toBe(1_000_000);
      expect(makanan.delta).toBe(250_000);
    });

    it('returns delta_bp null when previous month has zero data (AC-4)', async () => {
      const res = await request(app.getHttpServer())
        .get('/reports/monthly-comparison?month=2025-05')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.previous.expense).toBe(0);
      expect(res.body.delta_bp.expense).toBeNull();
      expect(res.body.delta_bp.income).toBeNull();
      expect(res.body.delta_bp.net).toBeNull();
    });
  });

  describe('AC-5: FR-REPORTS-011 - Reversals do not double count in reports', () => {
    it('reversed transaction does not affect summary, categories, or monthly-comparison, but is visible in /transactions', async () => {
      await prisma.asSystem().transactionSplit.deleteMany();
      await prisma.asSystem().transaction.deleteMany();

      // Original expense: 400.000 in November, status REVERSED
      const orig = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 400_000n,
          category_id: transportCatId,
          date: new Date('2026-11-05T00:00:00.000Z'),
          status: 'REVERSED',
          client_tx_id: 'tx-rev-orig',
        },
      });

      // Reversal record: type REVERSAL, status POSTED
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'REVERSAL',
          amount: 400_000n,
          parent_transaction_id: orig.id,
          date: new Date('2026-11-06T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-reversal',
        },
      });

      // Regular active expense: 150.000
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 150_000n,
          category_id: transportCatId,
          date: new Date('2026-11-07T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-active-exp',
        },
      });

      // 1. Check summary
      const sumRes = await request(app.getHttpServer())
        .get('/reports/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(sumRes.status).toBe(200);
      expect(sumRes.body.expense).toBe(150_000); // 400k reversed is excluded

      // 2. Check categories
      const catRes = await request(app.getHttpServer())
        .get('/reports/categories?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(catRes.status).toBe(200);
      expect(catRes.body.total).toBe(150_000);

      // 3. Check monthly-comparison
      const compRes = await request(app.getHttpServer())
        .get('/reports/monthly-comparison?month=2026-11')
        .set('Cookie', userAHeaders.cookie);
      expect(compRes.status).toBe(200);
      expect(compRes.body.current.expense).toBe(150_000);

      // 4. Check GET /transactions shows original with status REVERSED
      const txRes = await request(app.getHttpServer())
        .get('/transactions')
        .set('Cookie', userAHeaders.cookie);
      expect(txRes.status).toBe(200);
      const reversedTx = txRes.body.items.find((t: any) => t.id === orig.id);
      expect(reversedTx).toBeDefined();
      expect(reversedTx.status).toBe('REVERSED');
    });
  });

  describe('AC-6: FR-REPORTS-012 - SCHEDULED transactions do not affect reports', () => {
    it('scheduled transaction is ignored in summary, categories, balance-changes, and monthly-comparison', async () => {
      await prisma.asSystem().transactionSplit.deleteMany();
      await prisma.asSystem().transaction.deleteMany();

      // Transaksi SCHEDULED
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 9_999_999n,
          category_id: makananCatId,
          date: new Date('2026-11-10T00:00:00.000Z'),
          status: 'SCHEDULED',
          client_tx_id: 'tx-sched',
        },
      });

      // 1. Summary
      const sumRes = await request(app.getHttpServer())
        .get('/reports/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(sumRes.body.expense).toBe(0);

      // 2. Categories
      const catRes = await request(app.getHttpServer())
        .get('/reports/categories?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(catRes.body.total).toBe(0);

      // 3. Balance changes
      const balRes = await request(app.getHttpServer())
        .get('/reports/balance-changes?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(balRes.body.totals.outflow).toBe(0);

      // 4. Monthly comparison
      const compRes = await request(app.getHttpServer())
        .get('/reports/monthly-comparison?month=2026-11')
        .set('Cookie', userAHeaders.cookie);
      expect(compRes.body.current.expense).toBe(0);
    });
  });

  describe('TASK-085: CSV Export (GET /reports/export.csv)', () => {
    let txReversedId: string;

    beforeAll(async () => {
      // 1. Transaction with formula injection note and commas/newlines
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 20000n,
          date: new Date('2026-06-01T00:00:00.000Z'),
          status: 'POSTED',
          note: '=HYPERLINK("http://x")',
          client_tx_id: 'tx-formula-1',
        },
      });

      // 2. Transaction with comma and newline note
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 30000n,
          date: new Date('2026-06-02T00:00:00.000Z'),
          status: 'POSTED',
          note: 'Makan siang, soto\ndan es teh',
          client_tx_id: 'tx-comma-newline',
        },
      });

      // 3. Split transaction
      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 100000n,
          date: new Date('2026-06-03T00:00:00.000Z'),
          status: 'POSTED',
          client_tx_id: 'tx-split-1',
          splits: {
            create: [
              {
                category_id: makananCatId,
                amount: 60000n,
              },
              {
                category_id: transportCatId,
                amount: 40000n,
              },
            ],
          },
        },
      });

      // 4. Reversed transaction & Reversal transaction
      const txReversed = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date('2026-06-04T00:00:00.000Z'),
          status: 'REVERSED',
          client_tx_id: 'tx-reversed-1',
        },
      });
      txReversedId = txReversed.id;

      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'REVERSAL',
          amount: 50000n,
          date: new Date('2026-06-04T00:00:00.000Z'),
          status: 'POSTED',
          parent_transaction_id: txReversed.id,
          reason: 'Koreksi transaksi',
          client_tx_id: 'tx-reversal-1',
        },
      });
    });

    it('AC-1: begins with BOM EF BB BF, 16-column header, and lines end with \\r\\n', async () => {
      const res = await request(app.getHttpServer())
        .get('/reports/export.csv?date_from=2026-06-01&date_to=2026-06-05')
        .set('Cookie', userAHeaders.cookie)
        .buffer(true)
        .parse((res, callback) => {
          let data = Buffer.alloc(0);
          res.on('data', (chunk) => {
            data = Buffer.concat([data, chunk]);
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-type']).toContain('charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="duitku-transaksi.csv"',
      );

      const buffer = res.body as Buffer;
      // Check BOM EF BB BF
      expect(buffer[0]).toBe(0xef);
      expect(buffer[1]).toBe(0xbb);
      expect(buffer[2]).toBe(0xbf);

      const text = buffer.toString('utf-8');
      expect(
        text.startsWith(
          '\uFEFFID,Tanggal,Jenis,Status,Akun,Akun Tujuan,Kategori,Split,Nominal,Biaya Transfer,Mode Biaya,Tag,Catatan,Alasan,ID Transaksi Induk,Dibuat Pada\r\n',
        ),
      ).toBe(true);

      const lines = text.slice(1).split('\r\n');
      expect(lines.length).toBeGreaterThan(1);
    });

    it('AC-2: filters match GET /transactions exactly in IDs and ordering', async () => {
      const filter = {
        date_from: '2026-06-01',
        date_to: '2026-06-05',
        type: 'EXPENSE',
      };

      const [txRes, csvRes] = await Promise.all([
        request(app.getHttpServer())
          .get('/transactions')
          .query({ ...filter, limit: 100 })
          .set('Cookie', userAHeaders.cookie),
        request(app.getHttpServer())
          .get('/reports/export.csv')
          .query(filter)
          .set('Cookie', userAHeaders.cookie),
      ]);

      expect(txRes.status).toBe(200);
      expect(csvRes.status).toBe(200);

      const expectedIds = txRes.body.items.map((i: any) => i.id);
      const csvLines = csvRes.text.slice(1).trim().split('\r\n');
      const csvIds = csvLines.slice(1).map((line: string) => line.split(',')[0]);

      expect(csvIds).toEqual(expectedIds);
    });

    it('AC-4: anti-formula injection, newline handling, and nominal formatting', async () => {
      const res = await request(app.getHttpServer())
        .get('/reports/export.csv?date_from=2026-06-01&date_to=2026-06-02')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      // Formula note escaped: "'=HYPERLINK(""http://x"")"
      expect(res.text).toContain('"\'=HYPERLINK(""http://x"")"');
      // Comma and newline note properly wrapped: "Makan siang, soto\ndan es teh"
      expect(res.text).toContain('"Makan siang, soto\ndan es teh"');
      // Nominal not prefixed with single quote: 20000
      expect(res.text).toContain(',20000,');
    });

    it('AC-5: split transaction displays category:amount and reversal includes parent_transaction_id', async () => {
      const res = await request(app.getHttpServer())
        .get('/reports/export.csv?date_from=2026-06-03&date_to=2026-06-05')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      // Split formatting
      expect(res.text).toContain('Makanan & Minuman:60000|Transportasi:40000');
      // Reversed & Reversal transactions both appear
      expect(res.text).toContain('REVERSED');
      expect(res.text).toContain('REVERSAL');
      // Reversal has parent_transaction_id
      expect(res.text).toContain(txReversedId);
    });

    it('AC-6: C-01 isolation - querying other user account returns only header', async () => {
      const res = await request(app.getHttpServer())
        .get(`/reports/export.csv?account_id=${userBAccountId}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      const lines = res.text.slice(1).trim().split('\r\n');
      // Exactly 1 line (the header)
      expect(lines.length).toBe(1);
      expect(lines[0].startsWith('ID,Tanggal,Jenis')).toBe(true);
    });

    it('AC-3: streaming seeds 1500 transactions and streams via cursor in batches (1501 lines)', async () => {
      // Seed 1,500 transactions for User A in period 2026-05-01
      const seedData = Array.from({ length: 1500 }, (_, idx) => ({
        user_id: userAId,
        financial_profile_id: profileAId,
        account_id: bcaAccountId,
        type: 'EXPENSE' as const,
        amount: 1000n + BigInt(idx),
        date: new Date('2026-05-01T00:00:00.000Z'),
        status: 'POSTED' as const,
        client_tx_id: `tx-seed-1500-${String(idx).padStart(4, '0')}`,
      }));

      await prisma.asSystem().transaction.createMany({
        data: seedData,
      });

      const txService = app.get(TransactionsService);
      const listSpy = jest.spyOn(txService, 'list');

      const res = await request(app.getHttpServer())
        .get('/reports/export.csv?date_from=2026-05-01&date_to=2026-05-01')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);

      // Check exactly 1,501 lines (1 header + 1,500 data)
      const lines = res.text.slice(1).trim().split('\r\n');
      expect(lines.length).toBe(1501);

      // Verify list called multiple times with cursor (1500 items / 200 = 8 pages)
      expect(listSpy).toHaveBeenCalledTimes(8);
      listSpy.mockRestore();
    });

    it('AC-7: invalid query returns 400 and exceeding 10 req/min returns 429', async () => {
      // 1. Invalid date_from
      const invalidRes = await request(app.getHttpServer())
        .get('/reports/export.csv?date_from=abc')
        .set('Cookie', userAHeaders.cookie);
      expect(invalidRes.status).toBe(400);
      expect(invalidRes.body.code).toBe('VALIDATION_ERROR');

      // 2. Exceeding 10 requests per minute triggers 429
      let lastStatus = 200;
      for (let i = 0; i < 15; i++) {
        const res = await request(app.getHttpServer())
          .get('/reports/export.csv')
          .set('Cookie', userAHeaders.cookie);
        lastStatus = res.status;
        if (res.status === 429) {
          break;
        }
      }
      expect(lastStatus).toBe(429);
    });
  });

  describe('TASK-086: GET /reports/export.pdf', () => {
    it('AC-1: returns 200, application/pdf, and body starting with %PDF- header', async () => {
      const res = await request(app.getHttpServer())
        .get('/reports/export.pdf?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie)
        .responseType('blob');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBe('attachment; filename="duitku-laporan.pdf"');
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect(res.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    }, 20000);

    it('AC-6: invalid query returns 400 without launching Chromium', async () => {
      const res = await request(app.getHttpServer())
        .get('/reports/export.pdf?from=2026-11-30&to=2026-11-01')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('AC-6: exceeding 5 requests per minute returns 429', async () => {
      let lastStatus = 200;
      for (let i = 0; i < 10; i++) {
        const res = await request(app.getHttpServer())
          .get('/reports/export.pdf?from=2026-11-01&to=2026-11-30')
          .set('Cookie', userBHeaders.cookie);
        lastStatus = res.status;
        if (res.status === 429) {
          break;
        }
      }
      expect(lastStatus).toBe(429);
    }, 30000);
  });

  describe('AC-7: Swagger OpenAPI Documentation', () => {
    it('displays tag reports with routes and reference descriptions to /transactions and /budgets', async () => {
      const res = await request(app.getHttpServer()).get('/docs-json');
      expect(res.status).toBe(200);

      const paths = res.body.paths;
      expect(paths['/reports/summary']).toBeDefined();
      expect(paths['/reports/categories']).toBeDefined();
      expect(paths['/reports/balance-changes']).toBeDefined();
      expect(paths['/reports/monthly-comparison']).toBeDefined();
      expect(paths['/reports/export.csv']).toBeDefined();
      expect(paths['/reports/export.pdf']).toBeDefined();

      // Check tags
      expect(paths['/reports/summary'].get.tags).toContain('reports');
      expect(paths['/reports/categories'].get.tags).toContain('reports');
      expect(paths['/reports/balance-changes'].get.tags).toContain('reports');
      expect(paths['/reports/monthly-comparison'].get.tags).toContain('reports');
      expect(paths['/reports/export.csv'].get.tags).toContain('reports');
      expect(paths['/reports/export.pdf'].get.tags).toContain('reports');

      // Check reference descriptions
      const summaryDesc = paths['/reports/summary'].get.description ?? '';
      expect(summaryDesc).toContain('/transactions');
      expect(summaryDesc).toContain('/budgets');

      // Verify no duplicate proxy routes
      expect(paths['/reports/transactions']).toBeUndefined();
      expect(paths['/reports/budgets']).toBeUndefined();
    });
  });
});
