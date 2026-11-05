import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { todayInTz } from '../src/common/utils/date.js';

function generateTestUlid(): string {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let str = '0';
  for (let i = 1; i < 26; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}

describe('Budgets E2E Test Suite (Supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let throttlerStorage: any;

  let userAHeaders: { cookie: string };
  let userBHeaders: { cookie: string };
  let userAId: string;
  let userBId: string;
  let profileAId: string;

  let expenseCategoryAId: string;
  let incomeCategoryAId: string;
  let archivedCategoryAId: string;

  let accountA1Id: string;
  let accountA2Id: string;
  let accountBId: string;
  let archivedAccountAId: string;

  let currentPeriod: string;

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

    // Clean up
    await prisma.asSystem().transactionSplit.deleteMany();
    await prisma.asSystem().transactionAudit.deleteMany();
    await prisma.asSystem().transaction.deleteMany();
    await prisma.asSystem().rolloverConfig.deleteMany();
    await prisma.asSystem().budgetCategory.deleteMany();
    await prisma.asSystem().budgetPeriod.deleteMany();
    await prisma.asSystem().budget.deleteMany();
    await prisma.asSystem().auditLog.deleteMany({
      where: {
        resource_type: 'budget',
      },
    });
    await prisma.asSystem().user.deleteMany({
      where: {
        email: { endsWith: '@budget-test.com' },
      },
    });

    // Register User A
    const resA = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-a@budget-test.com',
        password: 'Password123!',
        name: 'User A Budget',
      });
    expect(resA.status).toBe(201);
    userAId = resA.body.user.id;
    const cookieA = resA.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userAHeaders = { cookie: cookieA };

    // Register User B
    const resB = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-b@budget-test.com',
        password: 'Password123!',
        name: 'User B Budget',
      });
    expect(resB.status).toBe(201);
    userBId = resB.body.user.id;
    const cookieB = resB.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userBHeaders = { cookie: cookieB };

    const profA = await prisma.financialProfile.findFirst({
      where: { user_id: userAId, is_default: true },
    });
    profileAId = profA!.id;

    const profB = await prisma.financialProfile.findFirst({
      where: { user_id: userBId, is_default: true },
    });

    const prefA = await prisma.userPreference.findFirst({
      where: { user_id: userAId },
    });
    const tz = prefA?.timezone ?? 'Asia/Jakarta';
    currentPeriod = todayInTz(tz).slice(0, 7);

    // Get categories for user A
    const expCat = await prisma.category.findFirst({
      where: { user_id: userAId, type: 'EXPENSE', archived: false },
    });
    expenseCategoryAId = expCat!.id;

    const incCat = await prisma.category.findFirst({
      where: { user_id: userAId, type: 'INCOME', archived: false },
    });
    incomeCategoryAId = incCat!.id;

    // Create an archived category for User A
    const archCat = await prisma.category.create({
      data: {
        financial_profile_id: profileAId,
        user_id: userAId,
        name: 'Kategori Arsip',
        type: 'EXPENSE',
        archived: true,
        archived_at: new Date(),
      },
    });
    archivedCategoryAId = archCat.id;

    // Create accounts for User A
    const acc1 = await prisma.account.create({
      data: {
        financial_profile_id: profileAId,
        user_id: userAId,
        name: 'BCA User A',
        type: 'BANK',
        balance: 10000000n,
        opening_balance: 10000000n,
        opening_date: new Date(),
      },
    });
    accountA1Id = acc1.id;

    const acc2 = await prisma.account.create({
      data: {
        financial_profile_id: profileAId,
        user_id: userAId,
        name: 'Mandiri User A',
        type: 'BANK',
        balance: 5000000n,
        opening_balance: 5000000n,
        opening_date: new Date(),
      },
    });
    accountA2Id = acc2.id;

    const archAcc = await prisma.account.create({
      data: {
        financial_profile_id: profileAId,
        user_id: userAId,
        name: 'Akun Arsip User A',
        type: 'BANK',
        balance: 1000000n,
        opening_balance: 1000000n,
        opening_date: new Date(),
        archived: true,
        archived_at: new Date(),
      },
    });
    archivedAccountAId = archAcc.id;

    // Create account for User B
    const accB = await prisma.account.create({
      data: {
        financial_profile_id: profB!.id,
        user_id: userBId,
        name: 'BCA User B',
        type: 'BANK',
        balance: 10000000n,
        opening_balance: 10000000n,
        opening_date: new Date(),
      },
    });
    accountBId = accB.id;
  });

  beforeEach(() => {
    throttlerStorage?._storage?.clear();
    throttlerStorage?.hitExpirations?.clear();
    if (throttlerStorage?.storage) {
      throttlerStorage.storage.clear();
    }
  });

  afterAll(async () => {
    await prisma.asSystem().transactionSplit.deleteMany();
    await prisma.asSystem().transactionAudit.deleteMany();
    await prisma.asSystem().transaction.deleteMany();
    await prisma.asSystem().rolloverConfig.deleteMany();
    await prisma.asSystem().budgetCategory.deleteMany();
    await prisma.asSystem().budgetPeriod.deleteMany();
    await prisma.asSystem().budget.deleteMany();
    await prisma.asSystem().user.deleteMany({
      where: {
        email: { endsWith: '@budget-test.com' },
      },
    });
    await app.close();
  });

  describe('AC-1: POST /budgets TOTAL', () => {
    it('membuat Budget TOTAL dan BudgetPeriod bulan berjalan, AuditLog BUDGET_CREATE, nominal bertipe number', async () => {
      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TOTAL',
          amount: 3000000,
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        type: 'TOTAL',
        category_id: null,
        scope_account_ids: [],
        period: currentPeriod,
        base_amount: 3000000,
        amount: 3000000,
        carryover_amount: 0,
        effective_amount: 3000000,
        rollover_enabled: false,
        locked_at: null,
      });
      expect(typeof res.body.base_amount).toBe('number');
      expect(typeof res.body.carryover_amount).toBe('number');

      // Check DB
      const budgetInDb = await prisma.budget.findFirst({
        where: { id: res.body.id, user_id: userAId },
      });
      expect(budgetInDb).not.toBeNull();
      expect(budgetInDb!.type).toBe('TOTAL');
      expect(budgetInDb!.category_id).toBeNull();
      expect(budgetInDb!.scope_account_ids).toEqual([]);

      const periodInDb = await prisma.budgetPeriod.findFirst({
        where: { budget_id: res.body.id, period: currentPeriod },
      });
      expect(periodInDb).not.toBeNull();
      expect(periodInDb!.base_amount).toBe(3000000n);
      expect(periodInDb!.carryover_amount).toBe(0n);

      // Check AuditLog
      const audit = await prisma.auditLog.findFirst({
        where: { resource_id: res.body.id, action: 'BUDGET_CREATE' },
      });
      expect(audit).not.toBeNull();
      expect(audit!.resource_type).toBe('budget');
      expect(audit!.actor_user_id).toBe(userAId);
    });
  });

  describe('AC-2: Duplicate Budget POST /budgets', () => {
    it('memanggil POST /budgets kedua kali di bulan yang sama melempar 409 BUDGET_ALREADY_EXISTS', async () => {
      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TOTAL',
          amount: 2500000,
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BUDGET_ALREADY_EXISTS');

      // Pastikan tidak tercipta 2 budget TOTAL untuk profil yang sama
      const totalBudgets = await prisma.budget.findMany({
        where: {
          user_id: userAId,
          financial_profile_id: profileAId,
          type: 'TOTAL',
          category_id: null,
        },
      });
      expect(totalBudgets.length).toBe(1);
    });
  });

  describe('AC-3: POST /budgets CATEGORY', () => {
    it('membuat Budget CATEGORY, BudgetPeriod, BudgetCategory, dan RolloverConfig secara konsisten', async () => {
      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: expenseCategoryAId,
          amount: 1500000,
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        type: 'CATEGORY',
        category_id: expenseCategoryAId,
        scope_account_ids: [],
        period: currentPeriod,
        base_amount: 1500000,
        amount: 1500000,
        carryover_amount: 0,
        effective_amount: 1500000,
        rollover_enabled: false,
        locked_at: null,
      });

      // Check DB
      const budgetPeriod = await prisma.budgetPeriod.findFirst({
        where: { budget_id: res.body.id, period: currentPeriod },
        include: {
          categories: {
            include: {
              rollover_config: true,
            },
          },
        },
      });
      expect(budgetPeriod).not.toBeNull();
      expect(budgetPeriod!.categories.length).toBe(1);

      const catRecord = budgetPeriod!.categories[0];
      expect(catRecord.category_id).toBe(expenseCategoryAId);
      expect(catRecord.amount).toBe(1500000n);
      expect(catRecord.rollover_enabled).toBe(false);
      expect(catRecord.carryover_amount).toBe(0n);
      expect(catRecord.rollover_config).not.toBeNull();
      expect(catRecord.rollover_config!.enabled).toBe(false);
    });
  });

  describe('AC-4: Guards & Validations (Rollover, Category Type & Archived)', () => {
    it('mengirim rollover_enabled: true pada budget TOTAL → 422 ROLLOVER_TOTAL_NOT_ALLOWED', async () => {
      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userBHeaders.cookie)
        .send({
          type: 'TOTAL',
          amount: 1000000,
          rollover_enabled: true,
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ROLLOVER_TOTAL_NOT_ALLOWED');
    });

    it('mengirim category_id bertipe INCOME → 400 INVALID_CATEGORY_TYPE', async () => {
      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: incomeCategoryAId,
          amount: 1000000,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CATEGORY_TYPE');
    });

    it('mengirim category_id yang diarsipkan → 422 CATEGORY_ARCHIVED', async () => {
      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: archivedCategoryAId,
          amount: 1000000,
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CATEGORY_ARCHIVED');
    });
  });

  describe('AC-5: Scope Account IDs', () => {
    it('menyimpan cakupan akun jika valid', async () => {
      // Create another category for User A
      const customCat = await prisma.category.create({
        data: {
          financial_profile_id: profileAId,
          user_id: userAId,
          name: 'Transportasi Khusus',
          type: 'EXPENSE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: customCat.id,
          amount: 500000,
          scope_account_ids: [accountA1Id, accountA2Id],
        });

      expect(res.status).toBe(201);
      expect(res.body.scope_account_ids).toEqual([accountA1Id, accountA2Id]);
    });

    it('melempar 404 ACCOUNT_NOT_FOUND jika scope_account_ids berisi akun milik user lain', async () => {
      const customCat = await prisma.category.create({
        data: {
          financial_profile_id: profileAId,
          user_id: userAId,
          name: 'Pendidikan Khusus',
          type: 'EXPENSE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: customCat.id,
          amount: 500000,
          scope_account_ids: [accountA1Id, accountBId],
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
    });

    it('melempar 409 ACCOUNT_ARCHIVED jika scope_account_ids berisi akun diarsipkan', async () => {
      const customCat = await prisma.category.create({
        data: {
          financial_profile_id: profileAId,
          user_id: userAId,
          name: 'Hiburan Khusus',
          type: 'EXPENSE',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: customCat.id,
          amount: 500000,
          scope_account_ids: [archivedAccountAId],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ACCOUNT_ARCHIVED');
    });
  });

  describe('AC-6: PATCH /budgets/:id mid-month', () => {
    it('mengubah amount & rollover_enabled pada budget CATEGORY, mempertahankan carryover_amount, menulis AuditLog', async () => {
      const cat = await prisma.category.create({
        data: {
          financial_profile_id: profileAId,
          user_id: userAId,
          name: 'Kesehatan Khusus',
          type: 'EXPENSE',
        },
      });

      const createRes = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: cat.id,
          amount: 1500000,
          rollover_enabled: false,
        });
      expect(createRes.status).toBe(201);
      const budgetId = createRes.body.id;

      // Update carryover amount in DB to simulate rollover from previous month
      await prisma.budgetPeriod.updateMany({
        where: { budget_id: budgetId, period: currentPeriod },
        data: { carryover_amount: 100000n },
      });
      await prisma.budgetCategory.updateMany({
        where: { category_id: cat.id },
        data: { carryover_amount: 100000n },
      });

      const patchRes = await request(app.getHttpServer())
        .patch(`/budgets/${budgetId}`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          amount: 1800000,
          rollover_enabled: true,
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.base_amount).toBe(1800000);
      expect(patchRes.body.amount).toBe(1800000);
      expect(patchRes.body.rollover_enabled).toBe(true);
      expect(patchRes.body.carryover_amount).toBe(100000);
      expect(patchRes.body.effective_amount).toBe(1900000);

      // Verify DB updates
      const updatedPeriod = await prisma.budgetPeriod.findFirst({
        where: { budget_id: budgetId, period: currentPeriod },
        include: {
          categories: {
            include: {
              rollover_config: true,
            },
          },
        },
      });
      expect(updatedPeriod!.base_amount).toBe(1800000n);
      expect(updatedPeriod!.categories[0].amount).toBe(1800000n);
      expect(updatedPeriod!.categories[0].rollover_enabled).toBe(true);
      expect(updatedPeriod!.categories[0].rollover_config!.enabled).toBe(true);
      expect(updatedPeriod!.categories[0].carryover_amount).toBe(100000n);

      // Verify AuditLog
      const audit = await prisma.auditLog.findFirst({
        where: { resource_id: budgetId, action: 'BUDGET_UPDATE' },
      });
      expect(audit).not.toBeNull();
      expect(audit!.actor_user_id).toBe(userAId);
    });
  });

  describe('AC-7: Periode lampau & periode terkunci', () => {
    it('POST pada periode lampau → 409 BUDGET_PERIOD_LOCKED', async () => {
      const res = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TOTAL',
          amount: 2000000,
          period: '2020-01',
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BUDGET_PERIOD_LOCKED');
    });

    it('PATCH pada periode lampau → 409 BUDGET_PERIOD_LOCKED', async () => {
      // Find User A's TOTAL budget
      const totalBudget = await prisma.budget.findFirst({
        where: { user_id: userAId, type: 'TOTAL' },
      });

      const res = await request(app.getHttpServer())
        .patch(`/budgets/${totalBudget!.id}`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          amount: 2000000,
          period: '2020-01',
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BUDGET_PERIOD_LOCKED');
    });

    it('PATCH pada BudgetPeriod yang terkunci (locked_at !== null) → 409 BUDGET_PERIOD_LOCKED', async () => {
      const totalBudget = await prisma.budget.findFirst({
        where: { user_id: userAId, type: 'TOTAL' },
      });

      // Lock current period
      await prisma.budgetPeriod.updateMany({
        where: { budget_id: totalBudget!.id, period: currentPeriod },
        data: { locked_at: new Date() },
      });

      const res = await request(app.getHttpServer())
        .patch(`/budgets/${totalBudget!.id}`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          amount: 4000000,
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BUDGET_PERIOD_LOCKED');
    });
  });

  describe('Tenant isolation & ownership', () => {
    it('User B tidak dapat PATCH budget milik User A (404 BUDGET_NOT_FOUND)', async () => {
      const totalBudget = await prisma.budget.findFirst({
        where: { user_id: userAId, type: 'TOTAL' },
      });

      const res = await request(app.getHttpServer())
        .patch(`/budgets/${totalBudget!.id}`)
        .set('Cookie', userBHeaders.cookie)
        .send({
          amount: 5000000,
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BUDGET_NOT_FOUND');
    });
  });

  describe('TASK-061: GET /budgets & GET /budgets/:id/usage', () => {
    let idMakanan: string;
    let idMakanSiang: string;
    let idTransportasi: string;
    let idBiayaTransfer: string;
    let budgetTotalId: string;
    let budgetMakananId: string;
    let budgetTransportId: string;

    beforeAll(async () => {
      // Find default categories for User A
      const m = await prisma.category.findFirst({
        where: { user_id: userAId, name: 'Makanan & Minuman' },
      });
      idMakanan = m!.id;

      const ms = await prisma.category.findFirst({
        where: { user_id: userAId, name: 'Makan Siang' },
      });
      idMakanSiang = ms!.id;

      const t = await prisma.category.findFirst({
        where: { user_id: userAId, name: 'Transportasi' },
      });
      idTransportasi = t!.id;

      const bt = await prisma.category.findFirst({
        where: { user_id: userAId, name: 'Biaya Transfer' },
      });
      idBiayaTransfer = bt!.id;

      // Clean all budgets & transactions for user A
      await prisma.asSystem().transactionSplit.deleteMany();
      await prisma.asSystem().transaction.deleteMany();
      await prisma.asSystem().rolloverConfig.deleteMany();
      await prisma.asSystem().budgetCategory.deleteMany();
      await prisma.asSystem().budgetPeriod.deleteMany();
      await prisma.asSystem().budget.deleteMany({
        where: { user_id: userAId },
      });

      // Create TOTAL budget: 1.000.000
      const resTotal = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'TOTAL',
          amount: 1000000,
          period: currentPeriod,
        });
      expect(resTotal.status).toBe(201);
      budgetTotalId = resTotal.body.id;

      // Create Makanan budget: 500.000
      const resMakanan = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: idMakanan,
          amount: 500000,
          period: currentPeriod,
          rollover_enabled: true,
        });
      expect(resMakanan.status).toBe(201);
      budgetMakananId = resMakanan.body.id;

      // Set carryover_amount = 100.000 on Makanan budget
      await prisma.budgetPeriod.updateMany({
        where: { budget_id: budgetMakananId, period: currentPeriod },
        data: { carryover_amount: 100000n },
      });
      await prisma.budgetCategory.updateMany({
        where: { category_id: idMakanan },
        data: { carryover_amount: 100000n },
      });

      // Create Transportasi budget: 300.000
      const resTrans = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: idTransportasi,
          amount: 300000,
          period: currentPeriod,
        });
      expect(resTrans.status).toBe(201);
      budgetTransportId = resTrans.body.id;
    });

    it('AC-1: Subcategory rollup 1 level & usage calculation for TOTAL & CATEGORY', async () => {
      // POSTED expense on parent Makanan: 150.000
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'EXPENSE',
          amount: 150000n,
          date: new Date(`${currentPeriod}-05`),
          status: 'POSTED',
          category_id: idMakanan,
          client_tx_id: generateTestUlid(),
        },
      });

      // POSTED expense on child Makan Siang: 90.000
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'EXPENSE',
          amount: 90000n,
          date: new Date(`${currentPeriod}-06`),
          status: 'POSTED',
          category_id: idMakanSiang,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/budgets?period=${currentPeriod}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.period).toBe(currentPeriod);
      expect(res.body.is_locked).toBe(false);

      // Check TOTAL budget
      expect(res.body.total_budget).toMatchObject({
        type: 'TOTAL',
        base_amount: 1000000,
        effective_amount: 1000000,
        spent_amount: 240000,
        remaining_amount: 760000,
        usage_percent: 24,
        status_level: 'NORMAL',
      });

      // Check Makanan budget
      const makananBudget = res.body.category_budgets.find(
        (b: any) => b.id === budgetMakananId,
      );
      expect(makananBudget).toBeDefined();
      expect(makananBudget).toMatchObject({
        type: 'CATEGORY',
        category_id: idMakanan,
        base_amount: 500000,
        carryover_amount: 100000,
        effective_amount: 600000,
        spent_amount: 240000,
        remaining_amount: 360000,
        usage_percent: 40,
        status_level: 'NORMAL',
      });

      // Check GET /budgets/:id/usage
      const usageRes = await request(app.getHttpServer())
        .get(`/budgets/${budgetMakananId}/usage?period=${currentPeriod}`)
        .set('Cookie', userAHeaders.cookie);

      expect(usageRes.status).toBe(200);
      expect(usageRes.body.spent_amount).toBe(240000);
      expect(usageRes.body.usage_percent).toBe(40);
    });

    it('AC-2 (Split): EXPENSE dengan splits menambah spent kategori & Total satu kali', async () => {
      // Split expense 100.000: Makanan 40.000, Transportasi 60.000
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'EXPENSE',
          amount: 100000n,
          date: new Date(`${currentPeriod}-07`),
          status: 'POSTED',
          client_tx_id: generateTestUlid(),
          splits: {
            create: [
              { category_id: idMakanan, amount: 40000n },
              { category_id: idTransportasi, amount: 60000n },
            ],
          },
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/budgets?period=${currentPeriod}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);

      // Previous 240.000 + 100.000 = 340.000
      expect(res.body.total_budget.spent_amount).toBe(340000);

      // Makanan: previous 240.000 + 40.000 = 280.000
      const makananBudget = res.body.category_budgets.find(
        (b: any) => b.id === budgetMakananId,
      );
      expect(makananBudget.spent_amount).toBe(280000);

      // Transportasi: 60.000
      const transportBudget = res.body.category_budgets.find(
        (b: any) => b.id === budgetTransportId,
      );
      expect(transportBudget.spent_amount).toBe(60000);
    });

    it('AC-3 (Reversal): Transaksi yang di-reverse menyumbang 0', async () => {
      // Create expense 150.000
      const tx = await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'EXPENSE',
          amount: 150000n,
          date: new Date(`${currentPeriod}-08`),
          status: 'POSTED',
          category_id: idMakanan,
          client_tx_id: generateTestUlid(),
        },
      });

      // Reverse it via API
      const revRes = await request(app.getHttpServer())
        .post(`/transactions/${tx.id}/reverse`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          reason: 'Salah nominal',
          client_tx_id: generateTestUlid(),
        });
      expect(revRes.status).toBe(201);

      // Verify that after reversal, spent is not increased by 150.000
      const res = await request(app.getHttpServer())
        .get(`/budgets?period=${currentPeriod}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.total_budget.spent_amount).toBe(340000);

      const makananBudget = res.body.category_budgets.find(
        (b: any) => b.id === budgetMakananId,
      );
      expect(makananBudget.spent_amount).toBe(280000);
    });

    it('AC-4 (Eksklusi C-09): Transaksi non-effective expense tidak dihitung', async () => {
      // SCHEDULED
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date(`${currentPeriod}-20`),
          status: 'SCHEDULED',
          category_id: idMakanan,
          client_tx_id: generateTestUlid(),
        },
      });

      // CANCELLED
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'EXPENSE',
          amount: 60000n,
          date: new Date(`${currentPeriod}-21`),
          status: 'CANCELLED',
          category_id: idMakanan,
          client_tx_id: generateTestUlid(),
        },
      });

      // INCOME
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'INCOME',
          amount: 5000000n,
          date: new Date(`${currentPeriod}-22`),
          status: 'POSTED',
          category_id: incomeCategoryAId,
          client_tx_id: generateTestUlid(),
        },
      });

      // ADJUSTMENT
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'ADJUSTMENT',
          amount: 10000n,
          date: new Date(`${currentPeriod}-23`),
          status: 'POSTED',
          client_tx_id: generateTestUlid(),
        },
      });

      // TRANSFER BUNDLED
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          to_account_id: accountA2Id,
          type: 'TRANSFER',
          fee_mode: 'BUNDLED',
          amount: 200000n,
          date: new Date(`${currentPeriod}-24`),
          status: 'POSTED',
          client_tx_id: generateTestUlid(),
        },
      });

      // TRANSFER Metode A SEPARATE companion fee
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'EXPENSE',
          amount: 6500n,
          date: new Date(`${currentPeriod}-25`),
          status: 'POSTED',
          category_id: idBiayaTransfer,
          client_tx_id: generateTestUlid(),
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/budgets?period=${currentPeriod}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      // Only the 6.500 fee transaction is counted: 340.000 + 6.500 = 346.500
      expect(res.body.total_budget.spent_amount).toBe(346500);

      const makananBudget = res.body.category_budgets.find(
        (b: any) => b.id === budgetMakananId,
      );
      // Makanan spent unchanged at 280.000
      expect(makananBudget.spent_amount).toBe(280000);
    });

    it('AC-5 (Scope & Arsip): Budget dengan scope akun menghitung transaksi historis saat akun diarsipkan', async () => {
      // Create a scoped category budget
      const customCat = await prisma.category.create({
        data: {
          financial_profile_id: profileAId,
          user_id: userAId,
          name: 'Belanja Offline',
          type: 'EXPENSE',
        },
      });

      const budgetScopedRes = await request(app.getHttpServer())
        .post('/budgets')
        .set('Cookie', userAHeaders.cookie)
        .send({
          type: 'CATEGORY',
          category_id: customCat.id,
          amount: 400000,
          period: currentPeriod,
          scope_account_ids: [accountA1Id],
        });
      expect(budgetScopedRes.status).toBe(201);
      const scopedBudgetId = budgetScopedRes.body.id;

      // Transaction on accountA2Id (outside scope) -> not counted
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA2Id,
          type: 'EXPENSE',
          amount: 50000n,
          date: new Date(`${currentPeriod}-10`),
          status: 'POSTED',
          category_id: customCat.id,
          client_tx_id: generateTestUlid(),
        },
      });

      // Transaction on accountA1Id (inside scope) -> counted
      await prisma.transaction.create({
        data: {
          user_id: userAId,
          financial_profile_id: profileAId,
          account_id: accountA1Id,
          type: 'EXPENSE',
          amount: 80000n,
          date: new Date(`${currentPeriod}-10`),
          status: 'POSTED',
          category_id: customCat.id,
          client_tx_id: generateTestUlid(),
        },
      });

      // Archive accountA1Id
      await prisma.account.update({
        where: { id: accountA1Id, user_id: userAId },
        data: { archived: true, archived_at: new Date() },
      });

      // Query budget usage: the 80.000 on accountA1Id MUST still be counted
      const res = await request(app.getHttpServer())
        .get(`/budgets/${scopedBudgetId}/usage?period=${currentPeriod}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.spent_amount).toBe(80000);

      // Restore accountA1Id
      await prisma.account.update({
        where: { id: accountA1Id, user_id: userAId },
        data: { archived: false, archived_at: null },
      });
    });

    it('AC-6 (Riwayat FR-BUDGET-008 & Isolasi C-01): Query periode lampau & user isolation', async () => {
      // Create past period in DB
      const pastPeriod = '2026-01';
      await prisma.budgetPeriod.create({
        data: {
          budget_id: budgetTotalId,
          period: pastPeriod,
          base_amount: 800000n,
          carryover_amount: 0n,
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/budgets?period=${pastPeriod}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.period).toBe(pastPeriod);
      expect(res.body.is_locked).toBe(true);
      expect(res.body.available_periods).toContain(pastPeriod);
      expect(res.body.available_periods).toContain(currentPeriod);
      // available_periods sorted descending
      expect(res.body.available_periods[0] >= res.body.available_periods[1]).toBe(true);

      // User B query User A budget usage -> 404 BUDGET_NOT_FOUND
      const userBUsageRes = await request(app.getHttpServer())
        .get(`/budgets/${budgetTotalId}/usage?period=${currentPeriod}`)
        .set('Cookie', userBHeaders.cookie);

      expect(userBUsageRes.status).toBe(404);
      expect(userBUsageRes.body.code).toBe('BUDGET_NOT_FOUND');
    });

    it('Validasi query parameter dan 404 jika period tidak ada', async () => {
      // Invalid period format
      const invRes = await request(app.getHttpServer())
        .get('/budgets?period=invalid')
        .set('Cookie', userAHeaders.cookie);
      expect(invRes.status).toBe(400);

      // Single usage with invalid UUID
      const uuidRes = await request(app.getHttpServer())
        .get('/budgets/not-a-uuid/usage')
        .set('Cookie', userAHeaders.cookie);
      expect(uuidRes.status).toBe(400);

      // Single usage for non-existent period
      const nonExistentPeriodRes = await request(app.getHttpServer())
        .get(`/budgets/${budgetMakananId}/usage?period=2025-01`)
        .set('Cookie', userAHeaders.cookie);
      expect(nonExistentPeriodRes.status).toBe(404);
      expect(nonExistentPeriodRes.body.code).toBe('BUDGET_NOT_FOUND');
    });
  });
});
