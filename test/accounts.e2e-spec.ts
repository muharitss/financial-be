import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';

describe('Accounts E2E Test Suite (Supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let throttlerStorage: any;

  let userAHeaders: { cookie: string };
  let userBHeaders: { cookie: string };
  let userAId: string;

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

    // Bersihkan test data
    await prisma.asSystem().transaction.deleteMany();
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.user.deleteMany({
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
        email: 'user-a@duitku.test',
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
        email: 'user-b@duitku.test',
        password: 'Password123!',
        name: 'User B',
      });
    expect(resB.status).toBe(201);
    const cookieB = resB.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userBHeaders = { cookie: cookieB };
  });

  beforeEach(() => {
    throttlerStorage?._storage?.clear();
    throttlerStorage?.hitExpirations?.clear();
  });

  afterAll(async () => {
    await prisma.asSystem().transaction.deleteMany();
    await prisma.asSystem().savingsAllocation.deleteMany();
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: '@duitku.test',
        },
      },
    });
    await app.close();
  });

  it('AC-1: POST /accounts tanpa cookie sesi -> 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/accounts')
      .send({
        name: 'BCA',
        type: 'BANK',
        opening_balance: 1250000,
      });

    expect(res.status).toBe(401);
  });

  it('AC-2 & AC-3: POST /accounts valid -> 201, format response benar, dan 1 audit log tercipta', async () => {
    const res = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'BCA',
        type: 'BANK',
        opening_balance: 1250000,
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('BCA');
    expect(res.body.type).toBe('BANK');
    expect(res.body.balance).toBe(1250000);
    expect(res.body.opening_balance).toBe(1250000);
    expect(res.body.reserved).toBe(0);
    expect(res.body.available).toBe(1250000);
    expect(res.body.allow_negative).toBe(false);
    expect(typeof res.body.balance).toBe('number');
    expect(typeof res.body.opening_balance).toBe('number');
    expect(typeof res.body.reserved).toBe('number');
    expect(typeof res.body.available).toBe('number');
    expect(res.body.opening_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // AC-3: Cek audit log
    const audit = await prisma.auditLog.findFirst({
      where: {
        action: 'ACCOUNT_CREATE',
        resource_id: res.body.id,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actor_user_id).toBe(userAId);
    expect(audit?.resource_type).toBe('account');
  });

  it('AC-4: Nama sama di profil yang sama -> 409 ACCOUNT_NAME_TAKEN; nama sama milik user lain -> 201', async () => {
    // User A mencoba membuat akun BCA lagi
    const resDuplicate = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'BCA',
        type: 'BANK',
        opening_balance: 500000,
      });

    expect(resDuplicate.status).toBe(409);
    expect(resDuplicate.body.code).toBe('ACCOUNT_NAME_TAKEN');

    // User B membuat akun BCA (nama sama tapi beda user/profil)
    const resUserB = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userBHeaders.cookie)
      .send({
        name: 'BCA',
        type: 'BANK',
        opening_balance: 500000,
      });

    expect(resUserB.status).toBe(201);
    expect(resUserB.body.name).toBe('BCA');
  });

  it('AC-5: opening_balance negatif, desimal, atau type salah -> 400 VALIDATION_ERROR', async () => {
    // opening_balance negatif
    const resNeg = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Mandiri Neg',
        type: 'BANK',
        opening_balance: -500,
      });
    expect(resNeg.status).toBe(400);
    expect(resNeg.body.code).toBe('VALIDATION_ERROR');

    // opening_balance desimal
    const resFloat = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Mandiri Float',
        type: 'BANK',
        opening_balance: 1000.5,
      });
    expect(resFloat.status).toBe(400);
    expect(resFloat.body.code).toBe('VALIDATION_ERROR');

    // type invalid
    const resInvalidType = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Unknown Type',
        type: 'CRYPTO',
        opening_balance: 1000,
      });
    expect(resInvalidType.status).toBe(400);
    expect(resInvalidType.body.code).toBe('VALIDATION_ERROR');
  });

  it('AC-6: opening_date besok -> 400 VALIDATION_ERROR; opening_date kemarin -> 201', async () => {
    // Tanggal besok
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const resTomorrow = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Future Acc',
        type: 'BANK',
        opening_balance: 10000,
        opening_date: tomorrowStr,
      });
    expect(resTomorrow.status).toBe(400);
    expect(resTomorrow.body.code).toBe('VALIDATION_ERROR');

    // Tanggal kemarin
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const resYesterday = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Past Acc',
        type: 'BANK',
        opening_balance: 10000,
        opening_date: yesterdayStr,
      });
    expect(resYesterday.status).toBe(201);
    expect(resYesterday.body.opening_date).toBe(yesterdayStr);
  });

  it('AC-7: Dua akun bertipe CASH dengan nama berbeda -> keduanya 201', async () => {
    const resCash1 = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Dompet Utama',
        type: 'CASH',
        opening_balance: 200000,
      });
    expect(resCash1.status).toBe(201);

    const resCash2 = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Uang Brankas',
        type: 'CASH',
        opening_balance: 1000000,
      });
    expect(resCash2.status).toBe(201);
  });

  it('AC-1 (GET): GET /accounts tanpa cookie -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/accounts');
    expect(res.status).toBe(401);
  });

  it('AC-2 (GET): User baru tanpa akun -> 200 []', async () => {
    const resNew = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-empty@duitku.test',
        password: 'Password123!',
        name: 'Empty User',
      });
    expect(resNew.status).toBe(201);
    const cookieNew = resNew.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');

    const res = await request(app.getHttpServer())
      .get('/accounts')
      .set('Cookie', cookieNew);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('AC-3 (GET): Akun balance = 500000 dengan 2 alokasi ACTIVE (100k + 50k) dan 1 RELEASED (70k) -> reserved = 150000, available = 350000', async () => {
    const resAcc = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Tabungan Khusus',
        type: 'BANK',
        opening_balance: 500000,
      });
    expect(resAcc.status).toBe(201);
    const accountId = resAcc.body.id;

    const profile = await prisma.financialProfile.findFirst({
      where: { user_id: userAId, is_default: true },
    });
    expect(profile).not.toBeNull();

    const goal = await prisma.savingsGoal.create({
      data: {
        id: randomUUID(),
        user_id: userAId,
        financial_profile_id: profile!.id,
        name: 'Target Liburan',
        target_amount: 10000000n,
      },
    });

    await prisma.savingsAllocation.create({
      data: {
        id: randomUUID(),
        savings_goal_id: goal.id,
        account_id: accountId,
        amount: 100000n,
        status: 'ACTIVE',
      },
    });
    await prisma.savingsAllocation.create({
      data: {
        id: randomUUID(),
        savings_goal_id: goal.id,
        account_id: accountId,
        amount: 50000n,
        status: 'ACTIVE',
      },
    });
    await prisma.savingsAllocation.create({
      data: {
        id: randomUUID(),
        savings_goal_id: goal.id,
        account_id: accountId,
        amount: 70000n,
        status: 'RELEASED',
      },
    });

    const res = await request(app.getHttpServer())
      .get('/accounts')
      .set('Cookie', userAHeaders.cookie);

    expect(res.status).toBe(200);
    const target = res.body.find((a: any) => a.id === accountId);
    expect(target).toBeDefined();
    expect(target.balance).toBe(500000);
    expect(target.reserved).toBe(150000);
    expect(target.available).toBe(350000);
  });

  it('AC-4 (GET): Akun arsip tidak muncul di GET /accounts, muncul di GET /accounts?include_archived=true dengan archived: true', async () => {
    const resAcc = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Diarsip',
        type: 'BANK',
        opening_balance: 100000,
      });
    expect(resAcc.status).toBe(201);
    const accountId = resAcc.body.id;

    await prisma.asSystem().account.update({
      where: { id: accountId },
      data: { archived: true, archived_at: new Date() },
    });

    const resWithoutArchived = await request(app.getHttpServer())
      .get('/accounts')
      .set('Cookie', userAHeaders.cookie);
    expect(resWithoutArchived.status).toBe(200);
    expect(resWithoutArchived.body.some((a: any) => a.id === accountId)).toBe(false);

    const resWithArchived = await request(app.getHttpServer())
      .get('/accounts?include_archived=true')
      .set('Cookie', userAHeaders.cookie);
    expect(resWithArchived.status).toBe(200);
    const archivedAcc = resWithArchived.body.find((a: any) => a.id === accountId);
    expect(archivedAcc).toBeDefined();
    expect(archivedAcc.archived).toBe(true);
    expect(archivedAcc.archived_at).not.toBeNull();
  });

  it('AC-5 (GET): User B memanggil GET /accounts -> tidak melihat satu pun akun user A', async () => {
    const userAAccounts = await prisma.account.findMany({
      where: { user_id: userAId },
    });
    const userAAccountIds = new Set(userAAccounts.map((a) => a.id));

    const resB = await request(app.getHttpServer())
      .get('/accounts?include_archived=true')
      .set('Cookie', userBHeaders.cookie);

    expect(resB.status).toBe(200);
    expect(resB.body.length).toBeGreaterThan(0);
    for (const acc of resB.body) {
      expect(userAAccountIds.has(acc.id)).toBe(false);
    }
  });

  it('AC-1 & AC-2 (PATCH): PATCH /accounts/:id valid -> 200, field berubah, balance tetap, dan audit log tercatat', async () => {
    const resCreate = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'BCA Awal',
        type: 'BANK',
        opening_balance: 500000,
        note: 'Awal',
      });
    expect(resCreate.status).toBe(201);
    const accountId = resCreate.body.id;

    const resPatch = await request(app.getHttpServer())
      .patch(`/accounts/${accountId}`)
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'BCA Utama',
        note: 'Gaji',
      });

    expect(resPatch.status).toBe(200);
    expect(resPatch.body.name).toBe('BCA Utama');
    expect(resPatch.body.note).toBe('Gaji');
    expect(resPatch.body.balance).toBe(500000);
    expect(resPatch.body.opening_balance).toBe(500000);

    const audit = await prisma.auditLog.findFirst({
      where: {
        action: 'ACCOUNT_UPDATE',
        resource_id: accountId,
      },
    });
    expect(audit).not.toBeNull();
    expect((audit?.before as any)?.name).toBe('BCA Awal');
    expect((audit?.after as any)?.name).toBe('BCA Utama');
  });

  it('AC-3 (PATCH): Body berisi opening_balance atau balance -> 400 VALIDATION_ERROR, data tidak berubah', async () => {
    const resCreate = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Cek Field Terlarang',
        type: 'BANK',
        opening_balance: 100000,
      });
    expect(resCreate.status).toBe(201);
    const accountId = resCreate.body.id;

    const resForbidden1 = await request(app.getHttpServer())
      .patch(`/accounts/${accountId}`)
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Nama Baru',
        opening_balance: 999999,
      });
    expect(resForbidden1.status).toBe(400);
    expect(resForbidden1.body.code).toBe('VALIDATION_ERROR');

    const resForbidden2 = await request(app.getHttpServer())
      .patch(`/accounts/${accountId}`)
      .set('Cookie', userAHeaders.cookie)
      .send({
        balance: 999999,
      });
    expect(resForbidden2.status).toBe(400);
    expect(resForbidden2.body.code).toBe('VALIDATION_ERROR');

    const acc = await prisma.account.findFirst({ where: { id: accountId, user_id: userAId } });
    expect(acc?.name).toBe('Akun Cek Field Terlarang');
    expect(acc?.balance).toBe(100000n);
  });

  it('AC-4 (PATCH): Body kosong {} -> 400 VALIDATION_ERROR', async () => {
    const resCreate = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Cek Empty Body',
        type: 'CASH',
        opening_balance: 50000,
      });
    expect(resCreate.status).toBe(201);
    const accountId = resCreate.body.id;

    const resEmpty = await request(app.getHttpServer())
      .patch(`/accounts/${accountId}`)
      .set('Cookie', userAHeaders.cookie)
      .send({});
    expect(resEmpty.status).toBe(400);
    expect(resEmpty.body.code).toBe('VALIDATION_ERROR');
  });

  it('AC-5 (PATCH): Ganti nama ke nama akun lain milik user yang sama -> 409 ACCOUNT_NAME_TAKEN', async () => {
    const resAcc1 = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Kembar 1',
        type: 'BANK',
        opening_balance: 10000,
      });
    expect(resAcc1.status).toBe(201);

    const resAcc2 = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Kembar 2',
        type: 'BANK',
        opening_balance: 10000,
      });
    expect(resAcc2.status).toBe(201);

    const resConflict = await request(app.getHttpServer())
      .patch(`/accounts/${resAcc2.body.id}`)
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Kembar 1',
      });
    expect(resConflict.status).toBe(409);
    expect(resConflict.body.code).toBe('ACCOUNT_NAME_TAKEN');
  });

  it('AC-6 (PATCH): Akun arsip -> 409 ACCOUNT_ARCHIVED', async () => {
    const resCreate = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Bakal Arsip',
        type: 'BANK',
        opening_balance: 10000,
      });
    expect(resCreate.status).toBe(201);
    const accountId = resCreate.body.id;

    await prisma.asSystem().account.update({
      where: { id: accountId },
      data: { archived: true, archived_at: new Date() },
    });

    const resArchived = await request(app.getHttpServer())
      .patch(`/accounts/${accountId}`)
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Nama Setelah Arsip',
      });
    expect(resArchived.status).toBe(409);
    expect(resArchived.body.code).toBe('ACCOUNT_ARCHIVED');
  });

  it('AC-7 (PATCH): User B PATCH akun user A -> 404 ACCOUNT_NOT_FOUND, data A tidak berubah', async () => {
    const resCreate = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Milik User A',
        type: 'BANK',
        opening_balance: 20000,
      });
    expect(resCreate.status).toBe(201);
    const accountId = resCreate.body.id;

    const resHack = await request(app.getHttpServer())
      .patch(`/accounts/${accountId}`)
      .set('Cookie', userBHeaders.cookie)
      .send({
        name: 'Dibajak User B',
      });
    expect(resHack.status).toBe(404);
    expect(resHack.body.code).toBe('ACCOUNT_NOT_FOUND');

    const acc = await prisma.account.findFirst({ where: { id: accountId, user_id: userAId } });
    expect(acc?.name).toBe('Akun Milik User A');
  });

  it('AC-8 (PATCH): id bukan UUID -> 400', async () => {
    const res = await request(app.getHttpServer())
      .patch('/accounts/bukan-uuid')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Test',
      });
    expect(res.status).toBe(400);
  });

  it('AC-1 & AC-2 (ARCHIVE): POST /accounts/:id/archive valid -> 200 & 1 audit log; pemanggilan kedua idempoten tanpa audit baru', async () => {
    const resCreate = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Untuk Arsip',
        type: 'BANK',
        opening_balance: 100000,
      });
    expect(resCreate.status).toBe(201);
    const accountId = resCreate.body.id;

    // Archive pertama kali
    const resArchive1 = await request(app.getHttpServer())
      .post(`/accounts/${accountId}/archive`)
      .set('Cookie', userAHeaders.cookie);

    expect(resArchive1.status).toBe(200);
    expect(resArchive1.body.archived).toBe(true);
    expect(resArchive1.body.archived_at).not.toBeNull();

    const auditCount1 = await prisma.auditLog.count({
      where: {
        action: 'ACCOUNT_ARCHIVE',
        resource_id: accountId,
      },
    });
    expect(auditCount1).toBe(1);

    // Archive kedua kali (idempoten)
    const resArchive2 = await request(app.getHttpServer())
      .post(`/accounts/${accountId}/archive`)
      .set('Cookie', userAHeaders.cookie);

    expect(resArchive2.status).toBe(200);
    expect(resArchive2.body.archived).toBe(true);
    expect(resArchive2.body.archived_at).toBe(resArchive1.body.archived_at);

    const auditCount2 = await prisma.auditLog.count({
      where: {
        action: 'ACCOUNT_ARCHIVE',
        resource_id: accountId,
      },
    });
    expect(auditCount2).toBe(1);
  });

  it('AC-3 (ARCHIVE): Akun dengan alokasi ACTIVE -> 409 ACCOUNT_HAS_ACTIVE_ALLOCATIONS, akun tetap aktif', async () => {
    const resAcc = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun Alokasi Tabungan',
        type: 'BANK',
        opening_balance: 200000,
      });
    expect(resAcc.status).toBe(201);
    const accountId = resAcc.body.id;

    const profile = await prisma.financialProfile.findFirst({
      where: { user_id: userAId, is_default: true },
    });
    const goal = await prisma.savingsGoal.create({
      data: {
        id: randomUUID(),
        user_id: userAId,
        financial_profile_id: profile!.id,
        name: 'Target Liburan Arsip',
        target_amount: 5000000n,
      },
    });
    await prisma.savingsAllocation.create({
      data: {
        id: randomUUID(),
        savings_goal_id: goal.id,
        account_id: accountId,
        amount: 50000n,
        status: 'ACTIVE',
      },
    });

    const resBlock = await request(app.getHttpServer())
      .post(`/accounts/${accountId}/archive`)
      .set('Cookie', userAHeaders.cookie);

    expect(resBlock.status).toBe(409);
    expect(resBlock.body.code).toBe('ACCOUNT_HAS_ACTIVE_ALLOCATIONS');

    const acc = await prisma.account.findFirst({ where: { id: accountId, user_id: userAId } });
    expect(acc?.archived).toBe(false);
  });

  it('AC-4 (ARCHIVE): Akun dengan transaksi SCHEDULED (sumber atau tujuan transfer) -> 409 ACCOUNT_HAS_SCHEDULED_TRANSACTIONS', async () => {
    const profile = await prisma.financialProfile.findFirst({
      where: { user_id: userAId, is_default: true },
    });

    // 1. Cek sebagai sumber transaksi scheduled
    const resSource = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Sumber Scheduled',
        type: 'BANK',
        opening_balance: 500000,
      });
    expect(resSource.status).toBe(201);
    const sourceId = resSource.body.id;

    await prisma.transaction.create({
      data: {
        id: randomUUID(),
        user_id: userAId,
        financial_profile_id: profile!.id,
        account_id: sourceId,
        type: 'EXPENSE',
        amount: 25000n,
        date: new Date('2026-12-15'),
        status: 'SCHEDULED',
        client_tx_id: randomUUID(),
      },
    });

    const resBlockSource = await request(app.getHttpServer())
      .post(`/accounts/${sourceId}/archive`)
      .set('Cookie', userAHeaders.cookie);

    expect(resBlockSource.status).toBe(409);
    expect(resBlockSource.body.code).toBe('ACCOUNT_HAS_SCHEDULED_TRANSACTIONS');

    // 2. Cek sebagai tujuan transfer scheduled
    const resTarget = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Tujuan Transfer Scheduled',
        type: 'BANK',
        opening_balance: 500000,
      });
    expect(resTarget.status).toBe(201);
    const targetId = resTarget.body.id;

    await prisma.transaction.create({
      data: {
        id: randomUUID(),
        user_id: userAId,
        financial_profile_id: profile!.id,
        account_id: sourceId,
        to_account_id: targetId,
        type: 'TRANSFER',
        amount: 50000n,
        date: new Date('2026-12-20'),
        status: 'SCHEDULED',
        client_tx_id: randomUUID(),
      },
    });

    const resBlockTarget = await request(app.getHttpServer())
      .post(`/accounts/${targetId}/archive`)
      .set('Cookie', userAHeaders.cookie);

    expect(resBlockTarget.status).toBe(409);
    expect(resBlockTarget.body.code).toBe('ACCOUNT_HAS_SCHEDULED_TRANSACTIONS');
  });

  it('AC-5 (ARCHIVE): Setelah arsip, akun hilang dari GET /accounts dan muncul di GET /accounts?include_archived=true', async () => {
    const resCreate = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun List Check',
        type: 'CASH',
        opening_balance: 50000,
      });
    expect(resCreate.status).toBe(201);
    const accountId = resCreate.body.id;

    // Sebelum arsip: ada di GET /accounts
    const beforeList = await request(app.getHttpServer())
      .get('/accounts')
      .set('Cookie', userAHeaders.cookie);
    expect(beforeList.body.some((a: any) => a.id === accountId)).toBe(true);

    // Arsipkan
    const resArchive = await request(app.getHttpServer())
      .post(`/accounts/${accountId}/archive`)
      .set('Cookie', userAHeaders.cookie);
    expect(resArchive.status).toBe(200);

    // Setelah arsip: hilang dari GET /accounts
    const afterList = await request(app.getHttpServer())
      .get('/accounts')
      .set('Cookie', userAHeaders.cookie);
    expect(afterList.body.some((a: any) => a.id === accountId)).toBe(false);

    // Muncul di GET /accounts?include_archived=true
    const afterListArchived = await request(app.getHttpServer())
      .get('/accounts?include_archived=true')
      .set('Cookie', userAHeaders.cookie);
    expect(afterListArchived.body.some((a: any) => a.id === accountId && a.archived === true)).toBe(true);
  });

  it('AC-6 (ARCHIVE): User B archive akun user A -> 404 ACCOUNT_NOT_FOUND, akun A tetap aktif', async () => {
    const resCreate = await request(app.getHttpServer())
      .post('/accounts')
      .set('Cookie', userAHeaders.cookie)
      .send({
        name: 'Akun User A Anti Bajak',
        type: 'BANK',
        opening_balance: 10000,
      });
    expect(resCreate.status).toBe(201);
    const accountId = resCreate.body.id;

    const resAttack = await request(app.getHttpServer())
      .post(`/accounts/${accountId}/archive`)
      .set('Cookie', userBHeaders.cookie);

    expect(resAttack.status).toBe(404);
    expect(resAttack.body.code).toBe('ACCOUNT_NOT_FOUND');

    const acc = await prisma.account.findFirst({ where: { id: accountId, user_id: userAId } });
    expect(acc?.archived).toBe(false);
  });

  describe('PATCH /accounts/:id/allow-negative', () => {
    it('AC-1 & AC-2: PATCH { allow_negative: true } -> 200, audit log tercatat; request ulang idempoten tanpa audit baru', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Negatif Test',
          type: 'BANK',
          opening_balance: 100000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;
      expect(resCreate.body.allow_negative).toBe(false);

      // AC-1: aktifkan allow_negative
      const resPatch1 = await request(app.getHttpServer())
        .patch(`/accounts/${accountId}/allow-negative`)
        .set('Cookie', userAHeaders.cookie)
        .send({ allow_negative: true });

      expect(resPatch1.status).toBe(200);
      expect(resPatch1.body.allow_negative).toBe(true);

      const audits = await prisma.auditLog.findMany({
        where: {
          resource_id: accountId,
          action: 'ACCOUNT_ALLOW_NEGATIVE_UPDATE',
        },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].before).toEqual({ allow_negative: false });
      expect(audits[0].after).toEqual({ allow_negative: true });

      // AC-2: request ulang sama -> idempoten, 200, tanpa audit baru
      const resPatch2 = await request(app.getHttpServer())
        .patch(`/accounts/${accountId}/allow-negative`)
        .set('Cookie', userAHeaders.cookie)
        .send({ allow_negative: true });

      expect(resPatch2.status).toBe(200);
      expect(resPatch2.body.allow_negative).toBe(true);

      const auditsAfter = await prisma.auditLog.findMany({
        where: {
          resource_id: accountId,
          action: 'ACCOUNT_ALLOW_NEGATIVE_UPDATE',
        },
      });
      expect(auditsAfter).toHaveLength(1);
    });

    it('AC-3: Saldo negatif (balance < 0) -> PATCH { allow_negative: false } -> 409 NEGATIVE_BALANCE_EXISTS', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Minus Test',
          type: 'EWALLET',
          opening_balance: 10000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      // Izinkan negatif dulu
      await request(app.getHttpServer())
        .patch(`/accounts/${accountId}/allow-negative`)
        .set('Cookie', userAHeaders.cookie)
        .send({ allow_negative: true });

      // Buat saldo < 0 via prisma
      await prisma.account.update({
        where: { id: accountId, user_id: userAId },
        data: { balance: -50000n },
      });

      // Coba matikan allow_negative
      const resDisable = await request(app.getHttpServer())
        .patch(`/accounts/${accountId}/allow-negative`)
        .set('Cookie', userAHeaders.cookie)
        .send({ allow_negative: false });

      expect(resDisable.status).toBe(409);
      expect(resDisable.body.code).toBe('NEGATIVE_BALANCE_EXISTS');

      const acc = await prisma.account.findFirst({ where: { id: accountId, user_id: userAId } });
      expect(acc?.allow_negative).toBe(true);
    });

    it('AC-4: Body { allow_negative: "yes" } atau field tambahan -> 400 VALIDATION_ERROR', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Schema Test',
          type: 'CASH',
          opening_balance: 10000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      const resString = await request(app.getHttpServer())
        .patch(`/accounts/${accountId}/allow-negative`)
        .set('Cookie', userAHeaders.cookie)
        .send({ allow_negative: 'yes' });
      expect(resString.status).toBe(400);
      expect(resString.body.code).toBe('VALIDATION_ERROR');

      const resExtra = await request(app.getHttpServer())
        .patch(`/accounts/${accountId}/allow-negative`)
        .set('Cookie', userAHeaders.cookie)
        .send({ allow_negative: true, extra_field: 'illegal' });
      expect(resExtra.status).toBe(400);
      expect(resExtra.body.code).toBe('VALIDATION_ERROR');
    });

    it('AC-5: Akun diarsipkan -> 409 ACCOUNT_ARCHIVED', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Arsip Negatif Test',
          type: 'BANK',
          opening_balance: 10000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      await request(app.getHttpServer())
        .post(`/accounts/${accountId}/archive`)
        .set('Cookie', userAHeaders.cookie);

      const resPatch = await request(app.getHttpServer())
        .patch(`/accounts/${accountId}/allow-negative`)
        .set('Cookie', userAHeaders.cookie)
        .send({ allow_negative: true });

      expect(resPatch.status).toBe(409);
      expect(resPatch.body.code).toBe('ACCOUNT_ARCHIVED');
    });

    it('AC-6 (isolasi): User B mengubah allow_negative akun user A -> 404 ACCOUNT_NOT_FOUND', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun User A Private Negatif',
          type: 'BANK',
          opening_balance: 10000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      const resAttack = await request(app.getHttpServer())
        .patch(`/accounts/${accountId}/allow-negative`)
        .set('Cookie', userBHeaders.cookie)
        .send({ allow_negative: true });

      expect(resAttack.status).toBe(404);
      expect(resAttack.body.code).toBe('ACCOUNT_NOT_FOUND');

      const acc = await prisma.account.findFirst({ where: { id: accountId, user_id: userAId } });
      expect(acc?.allow_negative).toBe(false);
    });
  });

  describe('POST /accounts/:id/adjust (TASK-034)', () => {
    function generateUlid(): string {
      const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      let str = '0';
      for (let i = 1; i < 26; i++) {
        str += chars[Math.floor(Math.random() * chars.length)];
      }
      return str;
    }

    it('AC-1 & AC-2: adjust target balance -> 201, update balance, buat Transaction ADJUSTMENT dan TransactionAudit', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Adjust AC-1',
          type: 'BANK',
          opening_balance: 1000000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      const clientTxId = generateUlid();
      const resAdjust = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          target_balance: 950000,
          reason: 'Selisih hitung kas fisik',
          client_tx_id: clientTxId,
        });

      expect(resAdjust.status).toBe(201);
      expect(resAdjust.body.amount).toBe(-50000);
      expect(resAdjust.body.account.balance).toBe(950000);
      expect(resAdjust.body.transaction_id).toBeDefined();

      const txRecord = await prisma.asSystem().transaction.findUnique({
        where: { id: resAdjust.body.transaction_id },
      });
      expect(txRecord).toBeDefined();
      expect(txRecord?.type).toBe('ADJUSTMENT');
      expect(Number(txRecord?.amount)).toBe(-50000);
      expect(txRecord?.reason).toBe('Selisih hitung kas fisik');

      const auditRecord = await prisma.asSystem().transactionAudit.findFirst({
        where: { transaction_id: resAdjust.body.transaction_id },
      });
      expect(auditRecord).toBeDefined();
      expect(auditRecord!.action).toBe('CREATE');
      expect((auditRecord!.before as any).account_balance).toBe(1000000);
      expect((auditRecord!.after as any).account_balance).toBe(950000);
    });

    it('AC-3: target_balance sama dengan saldo sekarang -> 422 NO_BALANCE_CHANGE', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Adjust AC-3',
          type: 'BANK',
          opening_balance: 500000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      const resAdjust = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          target_balance: 500000,
          reason: 'Saldo tidak berubah sama sekali',
          client_tx_id: generateUlid(),
        });

      expect(resAdjust.status).toBe(422);
      expect(resAdjust.body.code).toBe('NO_BALANCE_CHANGE');
    });

    it('AC-4: reason < 10 karakter -> 400 VALIDATION_ERROR', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Adjust AC-4',
          type: 'BANK',
          opening_balance: 500000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      const resAdjust = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          target_balance: 450000,
          reason: 'pendek',
          client_tx_id: generateUlid(),
        });

      expect(resAdjust.status).toBe(400);
      expect(resAdjust.body.code).toBe('VALIDATION_ERROR');
    });

    it('AC-5: target_balance negatif pada allow_negative = false -> 409 NEGATIVE_BALANCE_NOT_ALLOWED, pada true -> 201', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Adjust AC-5',
          type: 'BANK',
          opening_balance: 100000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      // 1. allow_negative = false -> 409
      const resNegBlocked = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          target_balance: -10000,
          reason: 'Penyesuaian kas minus belum diizinkan',
          client_tx_id: generateUlid(),
        });

      expect(resNegBlocked.status).toBe(409);
      expect(resNegBlocked.body.code).toBe('NEGATIVE_BALANCE_NOT_ALLOWED');

      // 2. Aktifkan allow_negative -> 201
      await request(app.getHttpServer())
        .patch(`/accounts/${accountId}/allow-negative`)
        .set('Cookie', userAHeaders.cookie)
        .send({ allow_negative: true });

      const resNegAllowed = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          target_balance: -10000,
          reason: 'Penyesuaian kas minus diizinkan',
          client_tx_id: generateUlid(),
        });

      expect(resNegAllowed.status).toBe(201);
      expect(resNegAllowed.body.account.balance).toBe(-10000);
    });

    it('AC-6: Akun diarsipkan -> 409 ACCOUNT_ARCHIVED', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Adjust AC-6 Arsip',
          type: 'BANK',
          opening_balance: 100000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      await request(app.getHttpServer())
        .post(`/accounts/${accountId}/archive`)
        .set('Cookie', userAHeaders.cookie);

      const resAdjust = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          target_balance: 50000,
          reason: 'Penyesuaian akun arsip ditolak',
          client_tx_id: generateUlid(),
        });

      expect(resAdjust.status).toBe(409);
      expect(resAdjust.body.code).toBe('ACCOUNT_ARCHIVED');
    });

    it('AC-7: Retry request identik dengan client_tx_id sama -> respons identik replayed', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Adjust AC-7 Idempoten',
          type: 'BANK',
          opening_balance: 300000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      const clientTxId = generateUlid();
      const payload = {
        target_balance: 200000,
        reason: 'Penyesuaian saldo idempoten',
        client_tx_id: clientTxId,
      };

      const res1 = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userAHeaders.cookie)
        .send(payload);
      expect(res1.status).toBe(201);

      const res2 = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userAHeaders.cookie)
        .send(payload);
      expect(res2.status).toBe(201);
      expect(res2.body.transaction_id).toBe(res1.body.transaction_id);
    });

    it('AC-8: Tanpa client_tx_id maupun header Idempotency-Key -> 422 MISSING_CLIENT_TX_ID', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Adjust AC-8 Missing Key',
          type: 'BANK',
          opening_balance: 300000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      const resAdjust = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userAHeaders.cookie)
        .send({
          target_balance: 250000,
          reason: 'Tanpa client_tx_id atau header',
        });

      expect(resAdjust.status).toBe(422);
      expect(resAdjust.body.code).toBe('MISSING_CLIENT_TX_ID');
    });

    it('AC-9 (isolasi): User B adjust akun milik User A -> 404 ACCOUNT_NOT_FOUND', async () => {
      const resCreate = await request(app.getHttpServer())
        .post('/accounts')
        .set('Cookie', userAHeaders.cookie)
        .send({
          name: 'Akun Adjust AC-9 Private',
          type: 'BANK',
          opening_balance: 200000,
        });
      expect(resCreate.status).toBe(201);
      const accountId = resCreate.body.id;

      const resAttack = await request(app.getHttpServer())
        .post(`/accounts/${accountId}/adjust`)
        .set('Cookie', userBHeaders.cookie)
        .send({
          target_balance: 50000,
          reason: 'Penyerang mencoba adjust akun',
          client_tx_id: generateUlid(),
        });

      expect(resAttack.status).toBe(404);
      expect(resAttack.body.code).toBe('ACCOUNT_NOT_FOUND');

      const acc = await prisma.account.findFirst({ where: { id: accountId, user_id: userAId } });
      expect(acc?.balance).toBe(200000n);
    });
  });
});
