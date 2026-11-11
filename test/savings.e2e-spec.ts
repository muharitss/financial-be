import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';

describe('Savings E2E Test Suite (Supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let throttlerStorage: any;

  let userAHeaders: { cookie: string };
  let userBHeaders: { cookie: string };
  let userAId: string;
  let userBId: string;
  let accountAId: string;

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

    // Clean up test data
    await prisma.asSystem().notification.deleteMany();
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.asSystem().savingsGoal.deleteMany();
    await prisma.asSystem().auditLog.deleteMany({
      where: {
        resource_type: { in: ['savings_goal', 'savings_allocation'] },
      },
    });
    await prisma.asSystem().user.deleteMany({
      where: {
        email: { endsWith: '@savings-test.com' },
      },
    });

    // Register User A
    const resA = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-a@savings-test.com',
        password: 'Password123!',
        name: 'User A',
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
        email: 'user-b@savings-test.com',
        password: 'Password123!',
        name: 'User B',
      });
    expect(resB.status).toBe(201);
    userBId = resB.body.user.id;
    expect(userBId).toBeDefined();
    const cookieB = resB.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userBHeaders = { cookie: cookieB };

    // Create an account for User A to use in allocation tests
    const accountRes = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'BCA User A Savings',
        type: 'BANK',
        opening_balance: 10000000,
      });
    expect(accountRes.status).toBe(201);
    accountAId = accountRes.body.id;
  });

  beforeEach(() => {
    throttlerStorage?._storage?.clear();
    throttlerStorage?.hitExpirations?.clear();
  });

  afterAll(async () => {
    await prisma.asSystem().notification.deleteMany();
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.asSystem().savingsGoal.deleteMany();
    await prisma.asSystem().auditLog.deleteMany({
      where: {
        resource_type: { in: ['savings_goal', 'savings_allocation'] },
      },
    });
    await prisma.asSystem().user.deleteMany({
      where: {
        email: { endsWith: '@savings-test.com' },
      },
    });
    await app.close();
  });

  describe('POST /savings/goals (AC-1, AC-2, AC-3)', () => {
    it('AC-1: berhasil membuat target tabungan dengan data valid dan mencatat AuditLog', async () => {
      const res = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Dana Darurat',
          target_amount: 5000000,
          target_date: '2027-06-01',
          note: 'Persiapan dana darurat 6 bulan',
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Dana Darurat',
        target_amount: 5000000,
        current_amount: 0,
        remaining_amount: 5000000,
        progress_percent: 0,
        target_date: '2027-06-01',
        note: 'Persiapan dana darurat 6 bulan',
        status: 'ACTIVE',
        achieved_at: null,
      });
      expect(res.body.id).toBeDefined();

      // Cek AuditLog
      const audit = await prisma.asSystem().auditLog.findFirst({
        where: {
          resource_type: 'savings_goal',
          resource_id: res.body.id,
          action: 'SAVINGS_GOAL_CREATE',
        },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actor_user_id).toBe(userAId);
    });

    it('AC-2: user yang sama membuat 2 target tabungan bernama sama -> keduanya 201 (FR-SAVINGS-005)', async () => {
      const res1 = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Liburan Akhir Tahun',
          target_amount: 3000000,
        });
      expect(res1.status).toBe(201);

      const res2 = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Liburan Akhir Tahun',
          target_amount: 4000000,
        });
      expect(res2.status).toBe(201);
      expect(res1.body.id).not.toBe(res2.body.id);
    });

    it('AC-3: target_amount <= 0 ditolak 400 VALIDATION_ERROR', async () => {
      const resZero = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Target Nol',
          target_amount: 0,
        });
      expect(resZero.status).toBe(400);
      expect(resZero.body.code).toBe('VALIDATION_ERROR');

      const resNegative = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Target Negatif',
          target_amount: -500000,
        });
      expect(resNegative.status).toBe(400);
      expect(resNegative.body.code).toBe('VALIDATION_ERROR');
    });

    it('AC-3: target_amount desimal (1000.5) ditolak 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Target Desimal',
          target_amount: 1000.5,
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('AC-3: target_date di masa lalu ditolak 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Target Masa Lalu',
          target_amount: 1000000,
          target_date: '2020-01-01',
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PATCH /savings/goals/:id (AC-4, AC-6)', () => {
    let goalId: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Target Edit Test',
          target_amount: 2000000,
          target_date: '2027-12-31',
          note: 'Catatan awal',
        });
      goalId = res.body.id;
    });

    it('AC-4: berhasil mengubah name, target_amount, target_date, note dan mencatat AuditLog SAVINGS_GOAL_UPDATE', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/savings/goals/${goalId}`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Target Edit Selesai',
          target_amount: 2500000,
          note: 'Catatan diubah',
        });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Target Edit Selesai');
      expect(res.body.target_amount).toBe(2500000);
      expect(res.body.note).toBe('Catatan diubah');
      expect(res.body.remaining_amount).toBe(2500000);

      const audit = await prisma.asSystem().auditLog.findFirst({
        where: {
          resource_type: 'savings_goal',
          resource_id: goalId,
          action: 'SAVINGS_GOAL_UPDATE',
        },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actor_user_id).toBe(userAId);
    });

    it('AC-4: menolak jika payload kosong tanpa field yang diupdate (400 VALIDATION_ERROR)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/savings/goals/${goalId}`)
        .set('Cookie', userAHeaders.cookie)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('AC-4: menolak jika target sudah berstatus ARCHIVED (409 GOAL_ARCHIVED)', async () => {
      // Arsipkan dulu
      const archiveRes = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/archive`)
        .set('Cookie', userAHeaders.cookie);
      expect(archiveRes.status).toBe(200);

      // Coba PATCH
      const res = await request(app.getHttpServer())
        .patch(`/savings/goals/${goalId}`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Coba Edit Goal Arsip',
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('GOAL_ARCHIVED');
    });

    it('AC-6: User B mengakses PATCH goal milik User A -> 404 GOAL_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/savings/goals/${goalId}`)
        .set('Cookie', userBHeaders.cookie)
        .send({
          name: 'Hacked by User B',
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('GOAL_NOT_FOUND');
    });
  });

  describe('POST /savings/goals/:id/archive (AC-5, AC-6)', () => {
    let goalId: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Target Arsip Test',
          target_amount: 1500000,
        });
      goalId = res.body.id;
    });

    it('AC-5: berhasil mengarsipkan target tanpa alokasi aktif -> 200, status ARCHIVED', async () => {
      const res = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/archive`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ARCHIVED');

      const audit = await prisma.asSystem().auditLog.findFirst({
        where: {
          resource_type: 'savings_goal',
          resource_id: goalId,
          action: 'SAVINGS_GOAL_ARCHIVE',
        },
      });
      expect(audit).not.toBeNull();
    });

    it('AC-5: idempoten saat dipanggil ulang pada goal yang sudah ARCHIVED', async () => {
      // Pertama kali
      const res1 = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/archive`)
        .set('Cookie', userAHeaders.cookie);
      expect(res1.status).toBe(200);

      const countBefore = await prisma.asSystem().auditLog.count({
        where: {
          resource_type: 'savings_goal',
          resource_id: goalId,
          action: 'SAVINGS_GOAL_ARCHIVE',
        },
      });
      expect(countBefore).toBe(1);

      // Kedua kali
      const res2 = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/archive`)
        .set('Cookie', userAHeaders.cookie);
      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('ARCHIVED');

      const countAfter = await prisma.asSystem().auditLog.count({
        where: {
          resource_type: 'savings_goal',
          resource_id: goalId,
          action: 'SAVINGS_GOAL_ARCHIVE',
        },
      });
      expect(countAfter).toBe(1); // tidak ada audit log baru
    });

    it('AC-5: menolak jika goal masih memiliki alokasi ACTIVE -> 409 GOAL_HAS_ACTIVE_ALLOCATIONS', async () => {
      // Sisipkan alokasi aktif secara manual di DB
      await prisma.asSystem().savingsAllocation.create({
        data: {
          savings_goal_id: goalId,
          account_id: accountAId,
          amount: 500000n,
          status: 'ACTIVE',
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/archive`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('GOAL_HAS_ACTIVE_ALLOCATIONS');

      // Bersihkan alokasi aktif (ubah jadi RELEASED)
      await prisma.asSystem().savingsAllocation.updateMany({
        where: { savings_goal_id: goalId },
        data: { status: 'RELEASED' },
      });

      // Sekarang arsip harus berhasil
      const resRetry = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/archive`)
        .set('Cookie', userAHeaders.cookie);
      expect(resRetry.status).toBe(200);
      expect(resRetry.body.status).toBe('ARCHIVED');
    });

    it('AC-6: User B mengakses POST archive goal milik User A -> 404 GOAL_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/archive`)
        .set('Cookie', userBHeaders.cookie);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('GOAL_NOT_FOUND');
    });
  });

  describe('POST /savings/goals/:id/allocations (AC-1, AC-2, AC-3, AC-4, AC-5, AC-6)', () => {
    let bcaAccountId: string;
    let goalId: string;

    beforeEach(async () => {
      // Buat akun BCA dengan balance 1.000.000
      const accRes = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `BCA Alloc Test ${Date.now()}`,
          type: 'BANK',
          opening_balance: 1000000,
        });
      expect(accRes.status).toBe(201);
      bcaAccountId = accRes.body.id;

      // Buat target tabungan 2.000.000
      const goalRes = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `Target Motor ${Date.now()}`,
          target_amount: 2000000,
        });
      expect(goalRes.status).toBe(201);
      goalId = goalRes.body.id;
    });

    it('AC-1: alokasi berhasil tanpa mengubah ledger balance akun, reserved terpotong, tanpa transaksi ledger, dan audit log tercatat', async () => {
      const initialTxCount = await prisma.asSystem().transaction.count();

      const res = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: bcaAccountId,
          amount: 400000,
        });

      expect(res.status).toBe(201);
      expect(res.body.allocation).toMatchObject({
        savings_goal_id: goalId,
        account_id: bcaAccountId,
        amount: 400000,
        status: 'ACTIVE',
      });
      expect(res.body.account_available).toBe(600000);
      expect(res.body.goal).toMatchObject({
        id: goalId,
        current_amount: 400000,
        remaining_amount: 1600000,
        progress_percent: 20,
        status: 'ACTIVE',
      });

      // 1. Ledger balance akun tetap 1.000.000
      const rawAccount = await prisma.asSystem().account.findUnique({
        where: { id: bcaAccountId },
      });
      expect(rawAccount?.balance).toBe(1000000n);

      // 2. GET /accounts menampilkan reserved = 400.000 & available = 600.000
      const listAccounts = await request(app.getHttpServer())
        .get('/accounts')
        .set('Cookie', userAHeaders.cookie);
      expect(listAccounts.status).toBe(200);
      const bcaInList = listAccounts.body.find((a: any) => a.id === bcaAccountId);
      expect(bcaInList.balance).toBe(1000000);
      expect(bcaInList.reserved).toBe(400000);
      expect(bcaInList.available).toBe(600000);

      // 3. Jumlah baris di tabel transactions tidak bertambah
      const finalTxCount = await prisma.asSystem().transaction.count();
      expect(finalTxCount).toBe(initialTxCount);

      // 4. Tercatat AuditLog SAVINGS_ALLOCATE
      const audit = await prisma.asSystem().auditLog.findFirst({
        where: {
          resource_type: 'savings_allocation',
          resource_id: res.body.allocation.id,
          action: 'SAVINGS_ALLOCATE',
        },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actor_user_id).toBe(userAId);
    });

    it('AC-2: menolak alokasi melebihi available (available = 600.000, butuh 700.000) meskipun allow_negative = true', async () => {
      // Alokasikan 400.000 dulu -> available = 600.000
      await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: bcaAccountId,
          amount: 400000,
        });

      // Aktifkan allow_negative pada akun
      await request(app.getHttpServer())
        .patch(`/accounts/${bcaAccountId}/allow-negative`)
        .set('Cookie', userAHeaders.cookie)
        .send({ allow_negative: true });

      // Coba alokasi 700.000 -> 409 INSUFFICIENT_AVAILABLE_BALANCE
      const res = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: bcaAccountId,
          amount: 700000,
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_AVAILABLE_BALANCE');
      expect(res.body.details?.available).toBe(600000);
      expect(res.body.details?.needed).toBe(700000);
    });

    it('AC-3: validasi akun negatif, akun arsip, akun illiquid (INVESTMENT/RECEIVABLE), dan goal ARCHIVED', async () => {
      // 1. Akun dengan saldo negatif
      const negAcc = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: (await prisma.asSystem().financialProfile.findFirstOrThrow({ where: { user_id: userAId, is_default: true } })).id,
          name: 'Akun Negatif Test',
          type: 'BANK',
          opening_balance: -50000n,
          balance: -50000n,
          opening_date: new Date(),
          allow_negative: true,
        },
      });
      const resNeg = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: negAcc.id,
          amount: 10000,
        });
      expect(resNeg.status).toBe(409);
      expect(resNeg.body.code).toBe('INSUFFICIENT_AVAILABLE_BALANCE');

      // 2. Akun arsip
      const archivedAcc = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: (await prisma.asSystem().financialProfile.findFirstOrThrow({ where: { user_id: userAId, is_default: true } })).id,
          name: 'Akun Arsip Test',
          type: 'BANK',
          opening_balance: 500000n,
          balance: 500000n,
          opening_date: new Date(),
          archived: true,
          archived_at: new Date(),
        },
      });
      const resArchived = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: archivedAcc.id,
          amount: 10000,
        });
      expect(resArchived.status).toBe(409);
      expect(resArchived.body.code).toBe('ACCOUNT_ARCHIVED');

      // 3. Akun INVESTMENT & RECEIVABLE -> 422 ACCOUNT_TYPE_NOT_ALLOCATABLE
      const investAcc = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: (await prisma.asSystem().financialProfile.findFirstOrThrow({ where: { user_id: userAId, is_default: true } })).id,
          name: 'Akun Reksadana',
          type: 'INVESTMENT',
          opening_balance: 1000000n,
          balance: 1000000n,
          opening_date: new Date(),
        },
      });
      const resInvest = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: investAcc.id,
          amount: 100000,
        });
      expect(resInvest.status).toBe(422);
      expect(resInvest.body.code).toBe('ACCOUNT_TYPE_NOT_ALLOCATABLE');

      const receivableAcc = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: (await prisma.asSystem().financialProfile.findFirstOrThrow({ where: { user_id: userAId, is_default: true } })).id,
          name: 'Piutang Teman',
          type: 'RECEIVABLE',
          opening_balance: 500000n,
          balance: 500000n,
          opening_date: new Date(),
        },
      });
      const resReceivable = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: receivableAcc.id,
          amount: 50000,
        });
      expect(resReceivable.status).toBe(422);
      expect(resReceivable.body.code).toBe('ACCOUNT_TYPE_NOT_ALLOCATABLE');

      // 4. Goal ARCHIVED -> 409 GOAL_ARCHIVED
      await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/archive`)
        .set('Cookie', userAHeaders.cookie);

      const resGoalArchived = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: bcaAccountId,
          amount: 100000,
        });
      expect(resGoalArchived.status).toBe(409);
      expect(resGoalArchived.body.code).toBe('GOAL_ARCHIVED');
    });

    it('AC-4: saat total alokasi mencapai target_amount, goal otomatis menjadi ACHIEVED', async () => {
      // Goal 2.000.000, alokasikan 2.000.000 dari akun bersaldo 3.000.000
      const richAcc = await prisma.asSystem().account.create({
        data: {
          user_id: userAId,
          financial_profile_id: (await prisma.asSystem().financialProfile.findFirstOrThrow({ where: { user_id: userAId, is_default: true } })).id,
          name: 'Akun Kaya',
          type: 'BANK',
          opening_balance: 3000000n,
          balance: 3000000n,
          opening_date: new Date(),
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: richAcc.id,
          amount: 2000000,
        });

      expect(res.status).toBe(201);
      expect(res.body.goal.status).toBe('ACHIEVED');
      expect(res.body.goal.achieved_at).not.toBeNull();
      expect(res.body.goal.current_amount).toBe(2000000);
      expect(res.body.goal.progress_percent).toBe(100);

      // Cek di DB
      const dbGoal = await prisma.asSystem().savingsGoal.findUnique({
        where: { id: goalId },
      });
      expect(dbGoal?.status).toBe('ACHIEVED');
      expect(dbGoal?.achieved_at).not.toBeNull();
    });

    it('AC-5: konkurensi alokasi paralel (saldo 1.000.000, dua request 600.000) -> tepat satu 201 dan satu 409', async () => {
      const p1 = request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: bcaAccountId,
          amount: 600000,
        });

      const p2 = request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: bcaAccountId,
          amount: 600000,
        });

      const [r1, r2] = await Promise.all([p1, p2]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      // Total reserved di DB harus 600.000, bukan 1.200.000
      const activeAllocations = await prisma.asSystem().savingsAllocation.aggregate({
        where: {
          account_id: bcaAccountId,
          status: 'ACTIVE',
        },
        _sum: { amount: true },
      });
      expect(activeAllocations._sum.amount).toBe(600000n);
    });

    it('AC-6: User B mengakses alokasi ke goal User A atau memakai account_id User B -> 404', async () => {
      // Buat akun milik User B
      const userBAcc = await prisma.asSystem().account.create({
        data: {
          user_id: userBId,
          financial_profile_id: (await prisma.asSystem().financialProfile.findFirstOrThrow({ where: { user_id: userBId, is_default: true } })).id,
          name: 'User B Bank',
          type: 'BANK',
          opening_balance: 1000000n,
          balance: 1000000n,
          opening_date: new Date(),
        },
      });

      // 1. User B coba alokasi ke goal User A -> 404 GOAL_NOT_FOUND
      const resBtoA = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userBHeaders.cookie)
        .send({
          account_id: userBAcc.id,
          amount: 100000,
        });
      expect(resBtoA.status).toBe(404);
      expect(resBtoA.body.code).toBe('GOAL_NOT_FOUND');

      // 2. User A coba alokasi memakai account_id milik User B -> 404 ACCOUNT_NOT_FOUND
      const resAusingBAcc = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: userBAcc.id,
          amount: 100000,
        });
      expect(resAusingBAcc.status).toBe(404);
      expect(resAusingBAcc.body.code).toBe('ACCOUNT_NOT_FOUND');
    });
  });

  describe('POST /savings/goals/:id/allocations/:allocationId/release (AC-1, AC-2, AC-3, AC-4)', () => {
    let bcaAccountId: string;
    let goalId: string;
    let allocId: string;

    beforeEach(async () => {
      // 1. Akun BCA balance = 1.000.000
      const accRes = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `BCA Release Test ${Date.now()}`,
          type: 'BANK',
          opening_balance: 1000000,
        });
      expect(accRes.status).toBe(201);
      bcaAccountId = accRes.body.id;

      // 2. Goal target 2.000.000
      const goalRes = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `Target Gadget ${Date.now()}`,
          target_amount: 2000000,
        });
      expect(goalRes.status).toBe(201);
      goalId = goalRes.body.id;

      // 3. Buat alokasi 400.000 (available menjadi 600.000)
      const allocRes = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: bcaAccountId,
          amount: 400000,
        });
      expect(allocRes.status).toBe(201);
      allocId = allocRes.body.allocation.id;
    });

    it('AC-1: rilis alokasi berhasil, status RELEASED, available balance BCA kembali 1.000.000, Account.balance tetap 1.000.000, 0 baris transaksi baru, dan AuditLog SAVINGS_RELEASE', async () => {
      const initialTxCount = await prisma.asSystem().transaction.count();

      const res = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations/${allocId}/release`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          reason: 'Butuh bayar UKT',
        });

      expect(res.status).toBe(200);
      expect(res.body.allocation).toMatchObject({
        id: allocId,
        savings_goal_id: goalId,
        account_id: bcaAccountId,
        amount: 400000,
        status: 'RELEASED',
        release_reason: 'Butuh bayar UKT',
      });
      expect(res.body.allocation.released_at).not.toBeNull();
      expect(res.body.account_available).toBe(1000000);
      expect(res.body.goal.current_amount).toBe(0);

      // 1. Account.balance tetap 1.000.000
      const rawAccount = await prisma.asSystem().account.findUnique({
        where: { id: bcaAccountId },
      });
      expect(rawAccount?.balance).toBe(1000000n);

      // 2. GET /accounts menampilkan available = 1.000.000 & reserved = 0
      const listAccounts = await request(app.getHttpServer())
        .get('/accounts')
        .set('Cookie', userAHeaders.cookie);
      expect(listAccounts.status).toBe(200);
      const bcaInList = listAccounts.body.find((a: any) => a.id === bcaAccountId);
      expect(bcaInList.balance).toBe(1000000);
      expect(bcaInList.reserved).toBe(0);
      expect(bcaInList.available).toBe(1000000);

      // 3. 0 baris baru di tabel transactions
      const finalTxCount = await prisma.asSystem().transaction.count();
      expect(finalTxCount).toBe(initialTxCount);

      // 4. AuditLog SAVINGS_RELEASE tercatat
      const audit = await prisma.asSystem().auditLog.findFirst({
        where: {
          resource_type: 'savings_allocation',
          resource_id: allocId,
          action: 'SAVINGS_RELEASE',
        },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actor_user_id).toBe(userAId);
      expect((audit?.after as any)?.status).toBe('RELEASED');
    });

    it('AC-2: memanggil /release kedua kali pada allocationId yang sama -> 409 ALLOCATION_ALREADY_RELEASED', async () => {
      // Rilis pertama
      const res1 = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations/${allocId}/release`)
        .set('Cookie', userAHeaders.cookie)
        .send({ reason: 'Rilis pertama' });
      expect(res1.status).toBe(200);

      // Rilis kedua
      const res2 = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations/${allocId}/release`)
        .set('Cookie', userAHeaders.cookie)
        .send({ reason: 'Rilis kedua' });
      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe('ALLOCATION_ALREADY_RELEASED');
    });

    it('AC-3: goal berstatus ACHIEVED (target 500k, current 500k) yang alokasinya dilepas sehingga current 300k otomatis kembali ke ACTIVE dan achieved_at = null', async () => {
      // 1. Buat goal dengan target 500.000
      const smallGoalRes = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `Target UKT ${Date.now()}`,
          target_amount: 500000,
        });
      expect(smallGoalRes.status).toBe(201);
      const smallGoalId = smallGoalRes.body.id;

      // 2. Buat alokasi 1: 300.000
      await request(app.getHttpServer())
        .post(`/savings/goals/${smallGoalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: accountAId,
          amount: 300000,
        });

      // 3. Buat alokasi 2: 200.000 -> Goal menjadi ACHIEVED (current = 500.000)
      const alloc2Res = await request(app.getHttpServer())
        .post(`/savings/goals/${smallGoalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: accountAId,
          amount: 200000,
        });
      expect(alloc2Res.status).toBe(201);
      expect(alloc2Res.body.goal.status).toBe('ACHIEVED');
      expect(alloc2Res.body.goal.achieved_at).not.toBeNull();
      const alloc2Id = alloc2Res.body.allocation.id;

      // 4. Lepaskan alokasi 2 (200.000) -> current menjadi 300.000 (< 500.000)
      const releaseRes = await request(app.getHttpServer())
        .post(`/savings/goals/${smallGoalId}/allocations/${alloc2Id}/release`)
        .set('Cookie', userAHeaders.cookie)
        .send();
      expect(releaseRes.status).toBe(200);
      expect(releaseRes.body.goal.status).toBe('ACTIVE');
      expect(releaseRes.body.goal.achieved_at).toBeNull();
      expect(releaseRes.body.goal.current_amount).toBe(300000);
      expect(releaseRes.body.goal.remaining_amount).toBe(200000);

      // Cek langsung di database
      const dbGoal = await prisma.asSystem().savingsGoal.findUnique({
        where: { id: smallGoalId },
      });
      expect(dbGoal?.status).toBe('ACTIVE');
      expect(dbGoal?.achieved_at).toBeNull();
    });

    it('AC-4: allocationId tidak ditemukan, milik goalId berbeda, atau milik user lain -> 404', async () => {
      // 1. Goal milik user lain (User B coba rilis alokasi User A) -> 404 GOAL_NOT_FOUND
      const resB = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations/${allocId}/release`)
        .set('Cookie', userBHeaders.cookie)
        .send();
      expect(resB.status).toBe(404);
      expect(resB.body.code).toBe('GOAL_NOT_FOUND');

      // 2. GoalId non-existent -> 404 GOAL_NOT_FOUND
      const nonExistentGoalId = '00000000-0000-0000-0000-000000000000';
      const resMissingGoal = await request(app.getHttpServer())
        .post(`/savings/goals/${nonExistentGoalId}/allocations/${allocId}/release`)
        .set('Cookie', userAHeaders.cookie)
        .send();
      expect(resMissingGoal.status).toBe(404);
      expect(resMissingGoal.body.code).toBe('GOAL_NOT_FOUND');

      // 3. AllocationId non-existent -> 404 ALLOCATION_NOT_FOUND
      const nonExistentAllocId = '00000000-0000-0000-0000-000000000000';
      const resMissingAlloc = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations/${nonExistentAllocId}/release`)
        .set('Cookie', userAHeaders.cookie)
        .send();
      expect(resMissingAlloc.status).toBe(404);
      expect(resMissingAlloc.body.code).toBe('ALLOCATION_NOT_FOUND');

      // 4. AllocationId ada tetapi milik goalId berbeda milik user yang sama -> 404 ALLOCATION_NOT_FOUND
      const otherGoalRes = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `Other Goal ${Date.now()}`,
          target_amount: 1000000,
        });
      expect(otherGoalRes.status).toBe(201);
      const otherGoalId = otherGoalRes.body.id;

      const resDiffGoal = await request(app.getHttpServer())
        .post(`/savings/goals/${otherGoalId}/allocations/${allocId}/release`)
        .set('Cookie', userAHeaders.cookie)
        .send();
      expect(resDiffGoal.status).toBe(404);
      expect(resDiffGoal.body.code).toBe('ALLOCATION_NOT_FOUND');
    });
  });

  describe('GET /savings/goals (AC-1)', () => {
    let goalActive1Id: string;
    let goalActive2Id: string;
    let goalArchivedId: string;

    beforeEach(async () => {
      // 1. Goal 1: Target 1.000.000, alokasi 400.000
      const res1 = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `List Goal 1 ${Date.now()}`,
          target_amount: 1000000,
        });
      expect(res1.status).toBe(201);
      goalActive1Id = res1.body.id;

      await request(app.getHttpServer())
        .post(`/savings/goals/${goalActive1Id}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: accountAId,
          amount: 400000,
        });

      // 2. Goal 2: Target 2.000.000, alokasi 0
      const res2 = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `List Goal 2 ${Date.now()}`,
          target_amount: 2000000,
        });
      expect(res2.status).toBe(201);
      goalActive2Id = res2.body.id;

      // 3. Goal 3: Target 500.000, diarsipkan
      const res3 = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `List Goal Archived ${Date.now()}`,
          target_amount: 500000,
        });
      expect(res3.status).toBe(201);
      goalArchivedId = res3.body.id;

      await request(app.getHttpServer())
        .post(`/savings/goals/${goalArchivedId}/archive`)
        .set('Cookie', userAHeaders.cookie);
    });

    it('AC-1: mengembalikan seluruh goal non-arsip milik user dengan progress integer akurat tanpa menyertakan goal ARCHIVED', async () => {
      const res = await request(app.getHttpServer())
        .get('/savings/goals')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const ids = res.body.map((g: any) => g.id);
      expect(ids).toContain(goalActive1Id);
      expect(ids).toContain(goalActive2Id);
      expect(ids).not.toContain(goalArchivedId);

      const g1 = res.body.find((g: any) => g.id === goalActive1Id);
      expect(g1.current_amount).toBe(400000);
      expect(g1.remaining_amount).toBe(600000);
      expect(g1.progress_percent).toBe(40);
      expect(Number.isInteger(g1.progress_percent)).toBe(true);

      const g2 = res.body.find((g: any) => g.id === goalActive2Id);
      expect(g2.current_amount).toBe(0);
      expect(g2.remaining_amount).toBe(2000000);
      expect(g2.progress_percent).toBe(0);
    });

    it('AC-1: menyertakan goal ARCHIVED saat include_archived=true', async () => {
      const res = await request(app.getHttpServer())
        .get('/savings/goals?include_archived=true')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      const ids = res.body.map((g: any) => g.id);
      expect(ids).toContain(goalActive1Id);
      expect(ids).toContain(goalActive2Id);
      expect(ids).toContain(goalArchivedId);

      const archivedGoal = res.body.find((g: any) => g.id === goalArchivedId);
      expect(archivedGoal.status).toBe('ARCHIVED');
    });

    it('AC-1: isolasi tenant: User B hanya melihat goal miliknya sendiri', async () => {
      const resB = await request(app.getHttpServer())
        .get('/savings/goals')
        .set('Cookie', userBHeaders.cookie);

      expect(resB.status).toBe(200);
      const ids = resB.body.map((g: any) => g.id);
      expect(ids).not.toContain(goalActive1Id);
      expect(ids).not.toContain(goalActive2Id);
    });
  });

  describe('GET /savings/goals/:id (AC-2)', () => {
    let detailGoalId: string;
    let alloc1Id: string;
    let alloc2Id: string;

    beforeEach(async () => {
      const goalRes = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `Detail Goal ${Date.now()}`,
          target_amount: 1000000,
        });
      expect(goalRes.status).toBe(201);
      detailGoalId = goalRes.body.id;

      // Alokasi 1: 400.000 lalu dilepaskan
      const alloc1Res = await request(app.getHttpServer())
        .post(`/savings/goals/${detailGoalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: accountAId,
          amount: 400000,
        });
      alloc1Id = alloc1Res.body.allocation.id;

      await request(app.getHttpServer())
        .post(`/savings/goals/${detailGoalId}/allocations/${alloc1Id}/release`)
        .set('Cookie', userAHeaders.cookie)
        .send({ reason: 'Butuh darurat' });

      // Alokasi 2: 300.000 (tetap ACTIVE)
      const alloc2Res = await request(app.getHttpServer())
        .post(`/savings/goals/${detailGoalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: accountAId,
          amount: 300000,
        });
      alloc2Id = alloc2Res.body.allocation.id;
    });

    it('AC-2: mengembalikan detail goal beserta seluruh riwayat alokasi ACTIVE dan RELEASED dengan account_name', async () => {
      const res = await request(app.getHttpServer())
        .get(`/savings/goals/${detailGoalId}`)
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.goal).toMatchObject({
        id: detailGoalId,
        current_amount: 300000,
        remaining_amount: 700000,
        progress_percent: 30,
        status: 'ACTIVE',
      });

      expect(res.body.allocations).toHaveLength(2);

      // Urut allocated_at desc: alokasi 2 terbaru di posisi pertama
      const itemActive = res.body.allocations.find((a: any) => a.id === alloc2Id);
      expect(itemActive).toMatchObject({
        id: alloc2Id,
        account_id: accountAId,
        account_name: 'BCA User A Savings',
        account_type: 'BANK',
        amount: 300000,
        status: 'ACTIVE',
        released_at: null,
        release_reason: null,
      });

      const itemReleased = res.body.allocations.find((a: any) => a.id === alloc1Id);
      expect(itemReleased).toMatchObject({
        id: alloc1Id,
        account_id: accountAId,
        account_name: 'BCA User A Savings',
        account_type: 'BANK',
        amount: 400000,
        status: 'RELEASED',
        release_reason: 'Butuh darurat',
      });
      expect(itemReleased.released_at).not.toBeNull();
    });

    it('AC-2: User B yang mengakses ID milik User A mendapat 404 GOAL_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer())
        .get(`/savings/goals/${detailGoalId}`)
        .set('Cookie', userBHeaders.cookie);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('GOAL_NOT_FOUND');
    });

    it('AC-2: ID target yang tidak ada mendapat 404 GOAL_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer())
        .get('/savings/goals/00000000-0000-0000-0000-000000000000')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('GOAL_NOT_FOUND');
    });
  });

  describe('Notifikasi SAVINGS_ACHIEVED (AC-3, AC-4, AC-5)', () => {
    it('AC-3: saat alokasi membuat target tabungan tercapai pertama kali, sistem mengirim tepat 1 notifikasi SAVINGS_ACHIEVED tanpa nominal Rupiah', async () => {
      // 1. Buat target tabungan 500.000
      const goalRes = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `Target Gadget Impian ${Date.now()}`,
          target_amount: 500000,
        });
      expect(goalRes.status).toBe(201);
      const goalId = goalRes.body.id;

      // 2. Alokasikan 500.000 hingga 100%
      const allocRes = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: accountAId,
          amount: 500000,
        });
      expect(allocRes.status).toBe(201);
      expect(allocRes.body.goal.status).toBe('ACHIEVED');

      // 3. Periksa notifikasi di DB
      const notifications = await prisma.asSystem().notification.findMany({
        where: {
          user_id: userAId,
          type: 'SAVINGS_ACHIEVED',
        },
      });

      const goalNotifs = notifications.filter(
        (n) => (n.data as any)?.savings_goal_id === goalId,
      );
      expect(goalNotifs).toHaveLength(1);

      const notif = goalNotifs[0];
      expect(notif.title).toBe('Target Tabungan Tercapai!');
      expect(notif.body).toContain('Target Gadget Impian');
      expect(notif.body).toContain('100%');
      // Privasi layar kunci: TIDAK boleh ada teks "Rp" atau angka nominal 500000 di title/body
      expect(notif.title).not.toMatch(/Rp/i);
      expect(notif.body).not.toMatch(/Rp/i);
      expect(notif.body).not.toContain('500.000');
      expect(notif.body).not.toContain('500000');
    });

    it('AC-4: deduplikasi siklus Release -> Re-allocate tidak mengirim notifikasi kedua', async () => {
      // 1. Buat target 400.000
      const goalRes = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `Target Dedup Notif ${Date.now()}`,
          target_amount: 400000,
        });
      const goalId = goalRes.body.id;

      // 2. Alokasikan 400.000 -> ACHIEVED (notifikasi pertama terkirim)
      const allocRes = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: accountAId,
          amount: 400000,
        });
      const allocId = allocRes.body.allocation.id;

      // 3. Lepaskan alokasi -> Goal kembali ACTIVE
      const releaseRes = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations/${allocId}/release`)
        .set('Cookie', userAHeaders.cookie)
        .send();
      expect(releaseRes.body.goal.status).toBe('ACTIVE');

      // 4. Alokasikan ulang 400.000 -> Goal kembali ACHIEVED
      await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: accountAId,
          amount: 400000,
        });

      // 5. Total notifikasi untuk goal ini HARUS tetap 1
      const notifications = await prisma.asSystem().notification.findMany({
        where: {
          user_id: userAId,
          type: 'SAVINGS_ACHIEVED',
        },
      });
      const goalNotifs = notifications.filter(
        (n) => (n.data as any)?.savings_goal_id === goalId,
      );
      expect(goalNotifs).toHaveLength(1);
    });

    it('AC-5: jika preferensi savings_achieved = false, tidak ada notifikasi yang dikirim saat goal tercapai', async () => {
      // 1. Matikan preferensi savings_achieved
      await prisma.asSystem().notificationPreference.upsert({
        where: { user_id: userAId },
        update: { savings_achieved: false },
        create: {
          user_id: userAId,
          savings_achieved: false,
        },
      });

      // 2. Buat target baru 300.000 dan capai 100%
      const goalRes = await request(app.getHttpServer())
        .post('/savings/goals')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: `Target Notif Disabled ${Date.now()}`,
          target_amount: 300000,
        });
      const goalId = goalRes.body.id;

      const allocRes = await request(app.getHttpServer())
        .post(`/savings/goals/${goalId}/allocations`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          account_id: accountAId,
          amount: 300000,
        });
      expect(allocRes.status).toBe(201);
      expect(allocRes.body.goal.status).toBe('ACHIEVED');

      // 3. Periksa notifikasi: tidak ada untuk goal ini
      const notifications = await prisma.asSystem().notification.findMany({
        where: {
          user_id: userAId,
          type: 'SAVINGS_ACHIEVED',
        },
      });
      const goalNotifs = notifications.filter(
        (n) => (n.data as any)?.savings_goal_id === goalId,
      );
      expect(goalNotifs).toHaveLength(0);

      // Kembalikan preferensi ke true
      await prisma.asSystem().notificationPreference.update({
        where: { user_id: userAId },
        data: { savings_achieved: true },
      });
    });
  });
});
