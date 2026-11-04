import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
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
});
