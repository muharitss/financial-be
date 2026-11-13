import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';

describe('Audit Logs E2E Test Suite (Superadmin Only, Redacted & Append-Only)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let throttlerStorage: any;

  let regularUserHeaders: { cookie: string };
  let superadminHeaders: { cookie: string };
  let regularUserId: string;
  let superadminId: string;

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

    // Bersihkan test data audit & user test
    await prisma.asSystem().auditLog.deleteMany({
      where: {
        actor_user_id: {
          in: ['test-actor-1', 'test-actor-2'],
        },
      },
    });

    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: '@duitku.audit.test',
        },
      },
    });

    // Registrasi Regular User
    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user@duitku.audit.test',
        password: 'Password123!',
        name: 'Regular User',
      });
    expect(regRes.status).toBe(201);
    regularUserId = regRes.body.user.id;
    const userCookie = regRes.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    regularUserHeaders = { cookie: userCookie };

    // Registrasi Superadmin
    const adminRegRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'superadmin@duitku.audit.test',
        password: 'Password123!',
        name: 'Super Admin',
      });
    expect(adminRegRes.status).toBe(201);
    superadminId = adminRegRes.body.user.id;

    // Promote ke SUPERADMIN
    await prisma.user.update({
      where: { id: superadminId },
      data: { role: 'SUPERADMIN' },
    });

    // Login sebagai SUPERADMIN agar JWT memiliki role SUPERADMIN
    const adminLoginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'superadmin@duitku.audit.test',
        password: 'Password123!',
      });
    expect(adminLoginRes.status).toBe(200);
    const adminCookie = adminLoginRes.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    superadminHeaders = { cookie: adminCookie };
  });

  beforeEach(() => {
    throttlerStorage?._storage?.clear();
    throttlerStorage?.hitExpirations?.clear();
    if (throttlerStorage?.storage) {
      throttlerStorage.storage.clear();
    }
  });

  afterAll(async () => {
    await prisma.asSystem().auditLog.deleteMany({
      where: {
        OR: [
          { actor_user_id: superadminId },
          { actor_user_id: regularUserId },
          { actor_user_id: { in: ['test-actor-1', 'test-actor-2'] } },
        ],
      },
    });
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: '@duitku.audit.test',
        },
      },
    });
    await app.close();
  });

  describe('AC-1: Role Guard & Autentikasi', () => {
    it('tanpa token mengembalikan 401 Unauthorized', async () => {
      const res = await request(app.getHttpServer()).get('/admin/audit-logs');
      expect(res.status).toBe(401);
    });

    it('user dengan role USER mengembalikan 403 SUPERADMIN_REQUIRED', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/audit-logs')
        .set(regularUserHeaders);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SUPERADMIN_REQUIRED');
      expect(res.body.message).toBe('Akses khusus Superadmin');
    });

    it('superadmin diizinkan mengakses GET /admin/audit-logs', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/audit-logs')
        .set(superadminHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body).toHaveProperty('next_cursor');
    });
  });

  describe('AC-2: Redaksi Ketat pada View Superadmin (FR-AUDIT-008)', () => {
    it('me-redact seluruh nilai finansial/rahasia namun mempertahankan action dan actor_user_id', async () => {
      const sensitiveLog = await prisma.auditLog.create({
        data: {
          action: 'TRANSACTION_CREATE',
          resource_type: 'transaction',
          resource_id: 'tx-12345',
          actor_user_id: 'test-actor-1',
          actor_role: 'USER',
          before: null,
          after: {
            amount: 500000,
            balance: 1500000,
            fee: 6500,
            note: 'beli makan',
            storage_key: 'users/avatar/receipt.jpg',
            description: 'Public description',
          },
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/admin/audit-logs?resource_id=tx-12345`)
        .set(superadminHeaders);

      expect(res.status).toBe(200);
      const found = res.body.items.find((item: any) => item.id === sensitiveLog.id);
      expect(found).toBeDefined();
      expect(found.action).toBe('TRANSACTION_CREATE');
      expect(found.actor_user_id).toBe('test-actor-1');

      // Nilai-nilai yang wajib di-redact
      expect(found.after.amount).toBe('[REDACTED]');
      expect(found.after.balance).toBe('[REDACTED]');
      expect(found.after.fee).toBe('[REDACTED]');
      expect(found.after.note).toBe('[REDACTED]');
      expect(found.after.storage_key).toBe('[REDACTED]');

      // Field non-sensitif tetap utuh
      expect(found.after.description).toBe('Public description');
    });
  });

  describe('AC-3: Meta-Audit (FR-AUDIT-004)', () => {
    it('memanggil GET /admin/audit-logs?action=LOGIN menciptakan baris AuditLog AUDIT_LOG_QUERY dengan hashed IP', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/audit-logs?action=LOGIN')
        .set(superadminHeaders)
        .set('User-Agent', 'E2E-Meta-Audit-Agent/1.0');

      expect(res.status).toBe(200);

      // Verifikasi baris meta-audit di database
      const metaLog = await prisma.auditLog.findFirst({
        where: {
          action: 'AUDIT_LOG_QUERY',
          actor_user_id: superadminId,
        },
        orderBy: { created_at: 'desc' },
      });

      expect(metaLog).toBeDefined();
      expect(metaLog?.resource_type).toBe('audit_log');
      expect(metaLog?.actor_role).toBe('SUPERADMIN');
      expect(metaLog?.user_agent).toBe('E2E-Meta-Audit-Agent/1.0');
      // SHA-256 hex string panjang 64 karakter
      expect(metaLog?.ip_address).toMatch(/^[0-9a-f]{64}$/);
      expect((metaLog?.after as any)?.query).toBeDefined();
      expect((metaLog?.after as any)?.query.action).toBe('LOGIN');
    });
  });

  describe('AC-4: Append-Only Enforce (FR-AUDIT-006)', () => {
    it('prisma.auditLog.update melempar AUDIT_LOG_IMMUTABLE', async () => {
      await expect(
        prisma.auditLog.update({
          where: { id: '00000000-0000-0000-0000-000000000000' },
          data: { action: 'MUTATED' },
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'AUDIT_LOG_IMMUTABLE',
          message: 'Audit log bersifat append-only',
        },
      });
    });

    it('prisma.auditLog.delete melempar AUDIT_LOG_IMMUTABLE', async () => {
      await expect(
        prisma.auditLog.delete({
          where: { id: '00000000-0000-0000-0000-000000000000' },
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'AUDIT_LOG_IMMUTABLE',
        },
      });
    });

    it('prisma.transactionAudit.deleteMany melempar AUDIT_LOG_IMMUTABLE', async () => {
      await expect(
        prisma.transactionAudit.deleteMany({}),
      ).rejects.toMatchObject({
        response: {
          code: 'AUDIT_LOG_IMMUTABLE',
        },
      });
    });

    it('prisma.asSystem() membypass append-only untuk retensi/hard-delete', async () => {
      const log = await prisma.asSystem().auditLog.create({
        data: {
          action: 'FOR_DELETE_TEST',
          resource_type: 'test',
        },
      });

      // asSystem() mengizinkan delete tanpa ForbiddenException
      await expect(
        prisma.asSystem().auditLog.delete({
          where: { id: log.id },
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('AC-5: Query Filters & Pagination', () => {
    const idA1 = randomUUID();
    const idB = randomUUID();
    const idA2 = randomUUID();

    beforeAll(async () => {
      // Seed audit logs untuk testing filter & cursor
      await prisma.auditLog.createMany({
        data: [
          {
            id: idA1,
            action: 'FILTER_TEST_A',
            resource_type: 'account',
            resource_id: 'res-a',
            actor_user_id: 'test-actor-1',
            actor_role: 'USER',
            created_at: new Date('2029-01-01T10:00:00Z'),
          },
          {
            id: idB,
            action: 'FILTER_TEST_B',
            resource_type: 'account',
            resource_id: 'res-b',
            actor_user_id: 'test-actor-2',
            actor_role: 'USER',
            created_at: new Date('2029-01-05T10:00:00Z'),
          },
          {
            id: idA2,
            action: 'FILTER_TEST_A',
            resource_type: 'budget',
            resource_id: 'res-c',
            actor_user_id: 'test-actor-1',
            actor_role: 'USER',
            created_at: new Date('2029-01-10T10:00:00Z'),
          },
        ],
      });
    });

    it('memfilter berdasarkan actor_user_id', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/audit-logs?actor_user_id=test-actor-2')
        .set(superadminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.items.every((i: any) => i.actor_user_id === 'test-actor-2')).toBe(true);
      expect(res.body.items.some((i: any) => i.action === 'FILTER_TEST_B')).toBe(true);
    });

    it('memfilter berdasarkan action', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/audit-logs?action=FILTER_TEST_B')
        .set(superadminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.items.every((i: any) => i.action === 'FILTER_TEST_B')).toBe(true);
    });

    it('memfilter berdasarkan resource_type', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/audit-logs?resource_type=budget')
        .set(superadminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.items.every((i: any) => i.resource_type === 'budget')).toBe(true);
    });

    it('memfilter berdasarkan rentang tanggal from dan to', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/audit-logs?from=2029-01-04&to=2029-01-06')
        .set(superadminHeaders);

      expect(res.status).toBe(200);
      const items = res.body.items.filter((i: any) => i.action.startsWith('FILTER_TEST'));
      expect(items).toHaveLength(1);
      expect(items[0].action).toBe('FILTER_TEST_B');
    });

    it('mendukung cursor pagination (limit & next_cursor)', async () => {
      // Page 1 dengan limit 1 untuk aksi FILTER_TEST_A (ada 2 data: idA2 [10 Jan] dan idA1 [01 Jan])
      const page1 = await request(app.getHttpServer())
        .get('/admin/audit-logs?action=FILTER_TEST_A&limit=1')
        .set(superadminHeaders);

      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.items[0].id).toBe(idA2);
      expect(page1.body.next_cursor).toBe(idA2);

      // Page 2 menggunakan cursor dari page 1
      const page2 = await request(app.getHttpServer())
        .get(`/admin/audit-logs?action=FILTER_TEST_A&limit=1&cursor=${page1.body.next_cursor}`)
        .set(superadminHeaders);

      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.items[0].id).toBe(idA1);
      expect(page2.body.next_cursor).toBeNull();
    });
  });
});
