import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';

describe('Notifications E2E Test Suite (Supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let throttlerStorage: any;

  let userAHeaders: { cookie: string };
  let userBHeaders: { cookie: string };
  let userAId: string;
  let userBId: string;

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
    await prisma.asSystem().pushSubscription.deleteMany();
    await prisma.asSystem().notificationPreference.deleteMany();
    await prisma.asSystem().notification.deleteMany();
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: '@duitku.notif.test',
        },
      },
    });

    // Registrasi User A
    const resA = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-a@duitku.notif.test',
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
        email: 'user-b@duitku.notif.test',
        password: 'Password123!',
        name: 'User B',
      });
    expect(resB.status).toBe(201);
    userBId = resB.body.user.id;
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
    await prisma.asSystem().pushSubscription.deleteMany();
    await prisma.asSystem().notificationPreference.deleteMany();
    await prisma.asSystem().notification.deleteMany();
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: '@duitku.notif.test',
        },
      },
    });
    await app.close();
  });

  describe('AC-1 & AC-2: POST /notifications/push-subscriptions', () => {
    const validEndpoint = 'https://fcm.googleapis.com/fcm/send/test-sub-token-123';

    it('AC-1: endpoint HTTPS valid menyimpan baris PushSubscription', async () => {
      const res = await request(app.getHttpServer())
        .post('/notifications/push-subscriptions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          endpoint: validEndpoint,
          keys: {
            p256dh: 'BNcRdreALRFdj...',
            auth: 'tBHItJAhVo...',
          },
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.endpoint).toBe(validEndpoint);
      expect(res.body.p256dh).toBe('BNcRdreALRFdj...');
      expect(res.body.auth).toBe('tBHItJAhVo...');

      const count = await prisma.asSystem().pushSubscription.count({
        where: { endpoint: validEndpoint },
      });
      expect(count).toBe(1);
    });

    it('AC-1: memanggil ulang dengan endpoint sama memperbarui p256dh/auth tanpa duplikat', async () => {
      const res = await request(app.getHttpServer())
        .post('/notifications/push-subscriptions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          endpoint: validEndpoint,
          keys: {
            p256dh: 'BNcRdreALRFdj-UPDATED',
            auth: 'tBHItJAhVo-UPDATED',
          },
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.p256dh).toBe('BNcRdreALRFdj-UPDATED');
      expect(res.body.auth).toBe('tBHItJAhVo-UPDATED');

      const all = await prisma.asSystem().pushSubscription.findMany({
        where: { endpoint: validEndpoint },
      });
      expect(all.length).toBe(1);
      expect(all[0].p256dh).toBe('BNcRdreALRFdj-UPDATED');
    });

    it('AC-2: endpoint skema http:// ditolak 422 INVALID_PUSH_ENDPOINT', async () => {
      const res = await request(app.getHttpServer())
        .post('/notifications/push-subscriptions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          endpoint: 'http://push.service.com/sub/123',
          keys: { p256dh: 'key', auth: 'auth' },
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_PUSH_ENDPOINT');
    });

    it('AC-2: endpoint host localhost ditolak 422 INVALID_PUSH_ENDPOINT', async () => {
      const res = await request(app.getHttpServer())
        .post('/notifications/push-subscriptions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          endpoint: 'https://localhost/push/sub',
          keys: { p256dh: 'key', auth: 'auth' },
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_PUSH_ENDPOINT');
    });

    it('AC-2: endpoint host loopback 127.0.0.1 ditolak 422 INVALID_PUSH_ENDPOINT', async () => {
      const res = await request(app.getHttpServer())
        .post('/notifications/push-subscriptions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          endpoint: 'https://127.0.0.1:8080/push/sub',
          keys: { p256dh: 'key', auth: 'auth' },
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_PUSH_ENDPOINT');
    });

    it('AC-2: endpoint host 169.254.169.254 ditolak 422 INVALID_PUSH_ENDPOINT', async () => {
      const res = await request(app.getHttpServer())
        .post('/notifications/push-subscriptions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          endpoint: 'https://169.254.169.254/latest/meta-data',
          keys: { p256dh: 'key', auth: 'auth' },
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_PUSH_ENDPOINT');
    });
  });

  describe('AC-3: DELETE /notifications/push-subscriptions (Isolasi C-01)', () => {
    const userAEndpoint = 'https://fcm.googleapis.com/fcm/send/user-a-isolated-device';

    beforeEach(async () => {
      await prisma.asSystem().pushSubscription.deleteMany({
        where: { endpoint: userAEndpoint },
      });
      await prisma.asSystem().pushSubscription.create({
        data: {
          user_id: userAId,
          endpoint: userAEndpoint,
          p256dh: 'keyA',
          auth: 'authA',
        },
      });
    });

    it('AC-3: DELETE oleh User B dengan endpoint milik User A tidak menghapus subscription User A', async () => {
      const res = await request(app.getHttpServer())
        .delete('/notifications/push-subscriptions')
        .set('Cookie', userBHeaders.cookie)
        .send({
          endpoint: userAEndpoint,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true });

      // Cek apakah subscription User A masih ada di DB
      const existing = await prisma.asSystem().pushSubscription.findUnique({
        where: { endpoint: userAEndpoint },
      });
      expect(existing).not.toBeNull();
      expect(existing?.user_id).toBe(userAId);
    });

    it('DELETE oleh User A dengan endpoint miliknya menghapus subscription (200 { deleted: true })', async () => {
      const res = await request(app.getHttpServer())
        .delete('/notifications/push-subscriptions')
        .set('Cookie', userAHeaders.cookie)
        .send({
          endpoint: userAEndpoint,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true });

      const existing = await prisma.asSystem().pushSubscription.findUnique({
        where: { endpoint: userAEndpoint },
      });
      expect(existing).toBeNull();
    });
  });

  describe('AC-4: GET /notifications/preferences (ADR-009 defaults)', () => {
    it('mengembalikan default weekly_summary = false, 6 lainnya true, quiet hours 22:00-07:00 enabled = true', async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications/preferences')
        .set('Cookie', userBHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.weekly_summary).toBe(false);
      expect(res.body.budget_warning_80).toBe(true);
      expect(res.body.budget_warning_100).toBe(true);
      expect(res.body.scheduled_reminder).toBe(true);
      expect(res.body.sync_failed).toBe(true);
      expect(res.body.savings_achieved).toBe(true);
      expect(res.body.monthly_summary).toBe(true);
      expect(res.body.quiet_hours_start).toBe('22:00');
      expect(res.body.quiet_hours_end).toBe('07:00');
      expect(res.body.quiet_hours_enabled).toBe(true);
    });
  });

  describe('AC-5: PATCH /notifications/preferences', () => {
    it('menyimpan perubahan preferensi yang valid', async () => {
      const res = await request(app.getHttpServer())
        .patch('/notifications/preferences')
        .set('Cookie', userBHeaders.cookie)
        .send({
          weekly_summary: true,
          quiet_hours_start: '21:30',
        });

      expect(res.status).toBe(200);
      expect(res.body.weekly_summary).toBe(true);
      expect(res.body.quiet_hours_start).toBe('21:30');

      // Ambil ulang untuk memastikan tersimpan di DB
      const getRes = await request(app.getHttpServer())
        .get('/notifications/preferences')
        .set('Cookie', userBHeaders.cookie);
      expect(getRes.body.weekly_summary).toBe(true);
      expect(getRes.body.quiet_hours_start).toBe('21:30');
    });

    it('menolak format jam tidak valid "25:99" dengan 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .patch('/notifications/preferences')
        .set('Cookie', userBHeaders.cookie)
        .send({
          quiet_hours_start: '25:99',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('menolak usaha mematikan security_alert dengan 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .patch('/notifications/preferences')
        .set('Cookie', userBHeaders.cookie)
        .send({
          security_alert: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Auth Guard Check', () => {
    it('menolak akses tanpa cookie sesi (401)', async () => {
      const resGet = await request(app.getHttpServer()).get('/notifications/preferences');
      expect(resGet.status).toBe(401);

      const resPost = await request(app.getHttpServer())
        .post('/notifications/push-subscriptions')
        .send({
          endpoint: 'https://fcm.googleapis.com/test',
          keys: { p256dh: 'k', auth: 'a' },
        });
      expect(resPost.status).toBe(401);
    });
  });

  describe('TASK-092 AC-5: In-App Notification Center & Sync Failed', () => {
    let notif1UserAId: string;
    let notif2UserAId: string;
    let notifUserBId: string;

    beforeEach(async () => {
      await prisma.asSystem().notification.deleteMany();

      // Buat 2 notifikasi untuk User A
      const n1 = await prisma.asSystem().notification.create({
        data: {
          user_id: userAId,
          type: 'BUDGET_WARNING_80',
          title: 'Notif 1',
          body: 'Notif 1 Body',
          created_at: new Date(Date.now() - 2000),
        },
      });
      notif1UserAId = n1.id;

      const n2 = await prisma.asSystem().notification.create({
        data: {
          user_id: userAId,
          type: 'SAVINGS_ACHIEVED',
          title: 'Notif 2',
          body: 'Notif 2 Body',
          created_at: new Date(Date.now() - 1000),
        },
      });
      notif2UserAId = n2.id;

      // Buat 1 notifikasi untuk User B
      const nB = await prisma.asSystem().notification.create({
        data: {
          user_id: userBId,
          type: 'SECURITY_ALERT',
          title: 'Notif User B',
          body: 'Notif User B Body',
        },
      });
      notifUserBId = nB.id;
    });

    it('GET /notifications mengembalikan daftar terurut terbaru + unread_count milik user (C-01)', async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications?limit=10')
        .set('Cookie', userAHeaders.cookie);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.unread_count).toBe(2);
      // Urutan terbaru di depan
      expect(res.body.items[0].id).toBe(notif2UserAId);
      expect(res.body.items[1].id).toBe(notif1UserAId);
    });

    it('PATCH /notifications/:id/read menandai telah dibaca dan menurunkan unread_count', async () => {
      const patchRes = await request(app.getHttpServer())
        .patch(`/notifications/${notif1UserAId}/read`)
        .set('Cookie', userAHeaders.cookie);

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.read_at).not.toBeNull();

      const getRes = await request(app.getHttpServer())
        .get('/notifications')
        .set('Cookie', userAHeaders.cookie);

      expect(getRes.status).toBe(200);
      expect(getRes.body.unread_count).toBe(1);
    });

    it('PATCH /notifications/:id/read mengakses notifikasi milik user lain mengembalikan 404 (C-01)', async () => {
      const patchRes = await request(app.getHttpServer())
        .patch(`/notifications/${notifUserBId}/read`)
        .set('Cookie', userAHeaders.cookie);

      expect(patchRes.status).toBe(404);
    });

    it('POST /notifications/read-all menandai semua unread menjadi read dan unread_count = 0', async () => {
      const postRes = await request(app.getHttpServer())
        .post('/notifications/read-all')
        .set('Cookie', userAHeaders.cookie);

      expect(postRes.status).toBe(200);

      const getRes = await request(app.getHttpServer())
        .get('/notifications')
        .set('Cookie', userAHeaders.cookie);

      expect(getRes.status).toBe(200);
      expect(getRes.body.unread_count).toBe(0);
    });

    it('POST /notifications/sync-failed melaporkan kegagalan sinkronisasi dan membuat notifikasi SYNC_FAILED', async () => {
      const res = await request(app.getHttpServer())
        .post('/notifications/sync-failed')
        .set('Cookie', userAHeaders.cookie)
        .send({ failed_count: 5 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const notifs = await prisma.asSystem().notification.findMany({
        where: { user_id: userAId, type: 'SYNC_FAILED' },
      });
      expect(notifs.length).toBeGreaterThanOrEqual(1);
      expect(notifs[0].title).toBe('Sinkronisasi Tertunda');
    });
  });
});
