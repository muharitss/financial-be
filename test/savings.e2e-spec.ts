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
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.asSystem().savingsGoal.deleteMany();
    await prisma.asSystem().auditLog.deleteMany({
      where: {
        resource_type: 'savings_goal',
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
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.asSystem().savingsGoal.deleteMany();
    await prisma.asSystem().auditLog.deleteMany({
      where: {
        resource_type: 'savings_goal',
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
});
