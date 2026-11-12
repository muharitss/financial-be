import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
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

    const subRestoran = await prisma.asSystem().category.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        parent_id: parentMakanan.id,
        name: 'Restoran',
        type: 'EXPENSE',
      },
    });
    restoranCatId = subRestoran.id;

    const catTransport = await prisma.asSystem().category.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        name: 'Transportasi',
        type: 'EXPENSE',
      },
    });
    transportCatId = catTransport.id;

    // Transaksi historis User A
    // 1. Oktober 2026
    await prisma.asSystem().transaction.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        account_id: bcaAccountId,
        type: 'INCOME',
        amount: 5_000_000n,
        date: new Date('2026-10-01T00:00:00.000Z'),
        status: 'POSTED',
        client_tx_id: 'tx-oct-1',
      },
    });
    await prisma.asSystem().transaction.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        account_id: bcaAccountId,
        category_id: makananCatId,
        type: 'EXPENSE',
        amount: 1_000_000n,
        date: new Date('2026-10-15T00:00:00.000Z'),
        status: 'POSTED',
        client_tx_id: 'tx-oct-2',
      },
    });

    // 2. November 2026 (periode aktif)
    await prisma.asSystem().transaction.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        account_id: bcaAccountId,
        type: 'INCOME',
        amount: 7_000_000n,
        date: new Date('2026-11-01T00:00:00.000Z'),
        status: 'POSTED',
        client_tx_id: 'tx-nov-1',
      },
    });
    await prisma.asSystem().transaction.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        account_id: bcaAccountId,
        category_id: restoranCatId, // Subkategori Makanan
        type: 'EXPENSE',
        amount: 750_000n,
        date: new Date('2026-11-05T00:00:00.000Z'),
        status: 'POSTED',
        client_tx_id: 'tx-nov-2',
      },
    });
    await prisma.asSystem().transaction.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        account_id: bcaAccountId,
        category_id: transportCatId,
        type: 'EXPENSE',
        amount: 500_000n,
        date: new Date('2026-11-10T00:00:00.000Z'),
        status: 'POSTED',
        client_tx_id: 'tx-nov-3',
      },
    });
    // Transfer BCA -> Dompet dengan biaya transfer
    await prisma.asSystem().transaction.create({
      data: {
        user_id: userAId,
        financial_profile_id: profileAId,
        account_id: bcaAccountId,
        to_account_id: dompetAccountId,
        type: 'TRANSFER',
        amount: 500_000n,
        transfer_fee: 2_500n,
        fee_mode: 'SEPARATE',
        date: new Date('2026-11-15T00:00:00.000Z'),
        status: 'POSTED',
        client_tx_id: 'tx-nov-4',
      },
    });

    // Transaksi User B
    await prisma.asSystem().transaction.create({
      data: {
        user_id: userBId,
        financial_profile_id: profileBId,
        account_id: userBAccountId,
        type: 'INCOME',
        amount: 99_000_000n,
        date: new Date('2026-11-01T00:00:00.000Z'),
        status: 'POSTED',
        client_tx_id: 'tx-user-b-1',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('AC-1 & AC-8: GET /reports/summary', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app.getHttpServer()).get('/reports/summary');
      expect(res.status).toBe(401);
    });

    it('filters by account_id and matches dashboard/summary when unfiltered', async () => {
      // 1. Tanpa filter
      const resAll = await request(app.getHttpServer())
        .get('/reports/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(resAll.status).toBe(200);

      const dashRes = await request(app.getHttpServer())
        .get('/dashboard/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(dashRes.status).toBe(200);

      expect(resAll.body.income).toBe(dashRes.body.income);
      expect(resAll.body.expense).toBe(dashRes.body.expense);
      expect(resAll.body.net).toBe(dashRes.body.net);

      // 2. Filter account_id BCA
      const resBca = await request(app.getHttpServer())
        .get(`/reports/summary?from=2026-11-01&to=2026-11-30&account_id=${bcaAccountId}`)
        .set('Cookie', userAHeaders.cookie);
      expect(resBca.status).toBe(200);
      expect(resBca.body.income).toBe(7_000_000);
      expect(resBca.body.expense).toBe(1_250_000);
    });

    it('AC-8: account_id of another user returns 0 data without leaking', async () => {
      const res = await request(app.getHttpServer())
        .get(`/reports/summary?from=2026-11-01&to=2026-11-30&account_id=${userBAccountId}`)
        .set('Cookie', userAHeaders.cookie);
      expect(res.status).toBe(200);
      expect(res.body.income).toBe(0);
      expect(res.body.expense).toBe(0);
      expect(res.body.net).toBe(0);
    });
  });

  describe('AC-2: GET /reports/categories', () => {
    it('rolls up subcategories into parent category and satisfies sum(items) === total', async () => {
      const res = await request(app.getHttpServer())
        .get('/reports/categories?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1_250_000);

      // Subkategori restoran harus digabung ke Makanan & Minuman
      const makananItem = res.body.items.find(
        (i: any) => i.name === 'Makanan & Minuman' || i.category_id === makananCatId,
      );
      expect(makananItem).toBeDefined();
      expect(makananItem.total).toBe(750_000);

      const sumItems = res.body.items.reduce((acc: number, curr: any) => acc + curr.total, 0);
      expect(sumItems).toBe(res.body.total);
    });
  });

  describe('AC-3: GET /reports/balance-changes', () => {
    it('satisfies closing - opening === inflow - outflow, and totals.closing === ledger_balance when to=today', async () => {
      const today = todayInTz('Asia/Jakarta');
      const res = await request(app.getHttpServer())
        .get(`/reports/balance-changes?from=2026-11-01&to=${today}`)
        .set('Cookie', userAHeaders.cookie);
      expect(res.status).toBe(200);

      const items = res.body.items;
      expect(items.length).toBe(2);

      for (const item of items) {
        expect(item.closing - item.opening).toBe(item.inflow - item.outflow);
      }

      const totals = res.body.totals;
      expect(totals.closing - totals.opening).toBe(totals.inflow - totals.outflow);

      // Cocokkan totals.closing dengan ledger_balance dari dashboard/balances
      const balRes = await request(app.getHttpServer())
        .get('/dashboard/balances')
        .set('Cookie', userAHeaders.cookie);
      expect(balRes.status).toBe(200);
      expect(totals.closing).toBe(balRes.body.ledger_balance);
    });
  });

  describe('AC-4: GET /reports/monthly-comparison', () => {
    it('computes comparison deltas and delta_bp properly (Oktober 1M, November 1.25M -> delta 250k, delta_bp 2500)', async () => {
      const res = await request(app.getHttpServer())
        .get('/reports/monthly-comparison?month=2026-11')
        .set('Cookie', userAHeaders.cookie);
      expect(res.status).toBe(200);

      expect(res.body.month).toBe('2026-11');
      expect(res.body.previous_month).toBe('2026-10');

      // Current (Nov): expense 1.250.000, income 7.000.000
      expect(res.body.current.expense).toBe(1_250_000);
      expect(res.body.current.income).toBe(7_000_000);

      // Previous (Oct): expense 1.000.000, income 5.000.000
      expect(res.body.previous.expense).toBe(1_000_000);
      expect(res.body.previous.income).toBe(5_000_000);

      // Delta: expense 250.000, delta_bp: 2500
      expect(res.body.delta.expense).toBe(250_000);
      expect(res.body.delta_bp.expense).toBe(2500);

      expect(res.body.delta.income).toBe(2_000_000);
      expect(res.body.delta_bp.income).toBe(4000); // 2M / 5M * 10000 = 4000 bp
    });

    it('returns delta_bp null when previous month has zero data (AC-4)', async () => {
      const res = await request(app.getHttpServer())
        .get('/reports/monthly-comparison?month=2026-10')
        .set('Cookie', userAHeaders.cookie);
      expect(res.status).toBe(200);

      // September tidak ada data expense (0)
      expect(res.body.previous.expense).toBe(0);
      expect(res.body.delta_bp.expense).toBeNull();
    });
  });

  describe('AC-5: FR-REPORTS-011 - Reversals do not double count in reports', () => {
    it('reversed transaction does not affect summary, categories, or monthly-comparison, but is visible in /transactions', async () => {
      // Buat expense lalu reverse
      const txOrig = await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          category_id: transportCatId,
          type: 'EXPENSE',
          amount: 300_000n,
          date: new Date('2026-11-20T00:00:00.000Z'),
          status: 'REVERSED',
          client_tx_id: 'tx-rev-test-orig',
        },
      });

      await prisma.asSystem().transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: bcaAccountId,
          type: 'REVERSAL',
          amount: 300_000n,
          date: new Date('2026-11-21T00:00:00.000Z'),
          status: 'POSTED',
          parent_transaction_id: txOrig.id,
          reason: 'Salah pencatatan',
          client_tx_id: 'tx-rev-test-reversal',
        },
      });

      // 1. GET /reports/summary: expense tetap 1.250.000 (tidak menjadi 1.550.000)
      const sumRes = await request(app.getHttpServer())
        .get('/reports/summary?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(sumRes.body.expense).toBe(1_250_000);

      // 2. GET /reports/categories: total transport tetap 500.000
      const catRes = await request(app.getHttpServer())
        .get('/reports/categories?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      const transportItem = catRes.body.items.find(
        (i: any) => i.category_id === transportCatId || i.name === 'Transportasi',
      );
      expect(transportItem.total).toBe(500_000);

      // 3. GET /reports/monthly-comparison: expense Nov tetap 1.250.000
      const compRes = await request(app.getHttpServer())
        .get('/reports/monthly-comparison?month=2026-11')
        .set('Cookie', userAHeaders.cookie);
      expect(compRes.body.current.expense).toBe(1_250_000);

      // 4. GET /transactions: transaksi REVERSED tetap terlihat (audit trail)
      const txRes = await request(app.getHttpServer())
        .get('/transactions')
        .set('Cookie', userAHeaders.cookie);
      const foundReversed = txRes.body.items.find((i: any) => i.id === txOrig.id);
      expect(foundReversed).toBeDefined();
      expect(foundReversed.status).toBe('REVERSED');
    });
  });

  describe('AC-6: FR-REPORTS-012 - SCHEDULED transactions do not affect reports', () => {
    it('scheduled transaction is ignored in summary, categories, balance-changes, and monthly-comparison', async () => {
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
      expect(sumRes.body.expense).toBe(1_250_000);

      // 2. Categories
      const catRes = await request(app.getHttpServer())
        .get('/reports/categories?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      expect(catRes.body.total).toBe(1_250_000);

      // 3. Balance changes
      const balRes = await request(app.getHttpServer())
        .get('/reports/balance-changes?from=2026-11-01&to=2026-11-30')
        .set('Cookie', userAHeaders.cookie);
      const bca = balRes.body.items.find((i: any) => i.account_id === bcaAccountId);
      expect(bca.outflow).toBe(1_752_500);

      // 4. Monthly comparison
      const compRes = await request(app.getHttpServer())
        .get('/reports/monthly-comparison?month=2026-11')
        .set('Cookie', userAHeaders.cookie);
      expect(compRes.body.current.expense).toBe(1_250_000);
    });
  });

  describe('AC-7: Swagger OpenAPI Documentation', () => {
    it('displays tag reports with 4 routes and reference descriptions to /transactions and /budgets', async () => {
      const res = await request(app.getHttpServer()).get('/docs-json');
      expect(res.status).toBe(200);

      const paths = res.body.paths;
      expect(paths['/reports/summary']).toBeDefined();
      expect(paths['/reports/categories']).toBeDefined();
      expect(paths['/reports/balance-changes']).toBeDefined();
      expect(paths['/reports/monthly-comparison']).toBeDefined();

      // Check tags
      expect(paths['/reports/summary'].get.tags).toContain('reports');
      expect(paths['/reports/categories'].get.tags).toContain('reports');
      expect(paths['/reports/balance-changes'].get.tags).toContain('reports');
      expect(paths['/reports/monthly-comparison'].get.tags).toContain('reports');

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
