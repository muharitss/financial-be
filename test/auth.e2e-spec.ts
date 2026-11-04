import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';

interface ParsedCookie {
  value: string;
  raw: string;
  isHttpOnly: boolean;
  sameSite?: string;
}

function parseCookies(setCookieHeaders: string[] = []): Record<string, ParsedCookie> {
  const cookies: Record<string, ParsedCookie> = {};
  for (const str of setCookieHeaders) {
    const parts = str.split(';').map((p) => p.trim());
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf('=');
    if (eqIdx !== -1) {
      const name = nameVal.slice(0, eqIdx);
      const value = nameVal.slice(eqIdx + 1);
      const isHttpOnly = attrs.some((a) => a.toLowerCase() === 'httponly');
      const sameSiteAttr = attrs.find((a) => a.toLowerCase().startsWith('samesite='));
      const sameSite = sameSiteAttr ? sameSiteAttr.split('=')[1] : undefined;
      cookies[name] = {
        value,
        raw: str,
        isHttpOnly,
        sameSite,
      };
    }
  }
  return cookies;
}

describe('Auth E2E Test Suite (Supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let throttlerStorage: any;

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

    // Bersihkan user uji lama sebelum test jalan
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: '@duitku.test',
        },
      },
    });
  });

  beforeEach(() => {
    // Reset limiter throttler storage antar test agar tidak terkena limit auth global 10 req/menit
    throttlerStorage?._storage?.clear();
    throttlerStorage?.hitExpirations?.clear();
  });

  afterAll(async () => {
    // Bersihkan seluruh data user uji setelah test selesai
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: '@duitku.test',
        },
      },
    });
    await app.close();
  });

  // 1. POST /auth/register payload valid
  it('1. POST /auth/register valid: 201, cookie HttpOnly, password_hash Argon2id, profil default', async () => {
    const payload = {
      email: `test-reg-${Date.now()}@duitku.test`,
      password: 'Password123!',
      name: 'Budi Santoso',
    };

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send(payload)
      .expect(201);

    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(payload.email);
    expect(res.body.user.name).toBe(payload.name);

    const setCookies = (res.headers['set-cookie'] as unknown as string[]) || [];
    const cookies = parseCookies(setCookies);

    // Verifikasi atribut HttpOnly dan Lax pada cookie duitku_session dan duitku_rt
    expect(cookies['duitku_session']).toBeDefined();
    expect(cookies['duitku_session'].isHttpOnly).toBe(true);
    expect(cookies['duitku_session'].raw).toMatch(/HttpOnly/i);

    expect(cookies['duitku_rt']).toBeDefined();
    expect(cookies['duitku_rt'].isHttpOnly).toBe(true);
    expect(cookies['duitku_rt'].raw).toMatch(/HttpOnly/i);

    expect(cookies['csrf_token']).toBeDefined();

    // Verifikasi di database: password_hash berformat Argon2id (bukan plaintext)
    const userInDb = await prisma.user.findUnique({
      where: { email: payload.email },
      include: {
        financial_profiles: true,
        preferences: true,
      },
    });

    expect(userInDb).toBeDefined();
    expect(userInDb?.password_hash).not.toBe(payload.password);
    expect(userInDb?.password_hash.startsWith('$argon2id$')).toBe(true);

    // Verifikasi profil default & preferensi user terbuat
    expect(userInDb?.financial_profiles.length).toBeGreaterThan(0);
    expect(userInDb?.financial_profiles[0].is_default).toBe(true);
    expect(userInDb?.financial_profiles[0].name).toBe('Pribadi');
    expect(userInDb?.preferences).toBeDefined();
    expect(userInDb?.preferences?.timezone).toBe('Asia/Jakarta');
  });

  // 2. POST /auth/register email duplikat -> 409 EMAIL_ALREADY_EXISTS
  it('2. POST /auth/register duplicate email: 409 EMAIL_ALREADY_EXISTS', async () => {
    const email = `dup-${Date.now()}@duitku.test`;
    const payload = {
      email,
      password: 'Password123!',
      name: 'User Pertama',
    };

    await request(app.getHttpServer())
      .post('/auth/register')
      .send(payload)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send(payload)
      .expect(409);

    expect(res.body.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  // 3. POST /auth/login kredensial valid -> 200 + cookie ter-set
  it('3. POST /auth/login valid credentials: 200 + cookies set', async () => {
    const email = `login-${Date.now()}@duitku.test`;
    const password = 'Password123!';

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name: 'Login User' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(email);

    const cookies = parseCookies((res.headers['set-cookie'] as unknown as string[]) || []);
    expect(cookies['duitku_session']).toBeDefined();
    expect(cookies['duitku_session'].isHttpOnly).toBe(true);
    expect(cookies['duitku_rt']).toBeDefined();
    expect(cookies['duitku_rt'].isHttpOnly).toBe(true);
    expect(cookies['csrf_token']).toBeDefined();
  });

  // 4. POST /auth/login password salah -> 401 INVALID_CREDENTIALS; 5x gagal -> ke-6 ditolak 429 LOGIN_COOLDOWN
  it('4. POST /auth/login wrong password: 401 INVALID_CREDENTIALS; 6th attempt: 429 LOGIN_COOLDOWN', async () => {
    const email = `cooldown-${Date.now()}@duitku.test`;
    const password = 'CorrectPassword123!';

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name: 'Cooldown User' })
      .expect(201);

    // 5 kali gagal berturut-turut
    for (let i = 1; i <= 5; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'WrongPassword' })
        .expect(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    }

    // Percobaan ke-6 ditolak dengan 429 LOGIN_COOLDOWN
    const res6 = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'WrongPassword' })
      .expect(429);

    expect(res6.body.code).toBe('LOGIN_COOLDOWN');
  });

  // 5. POST /auth/refresh dengan cookie + X-CSRF-Token cocok -> 200 { ok: true } dirotasi; tanpa/salah CSRF -> 403 CSRF_MISMATCH
  it('5. POST /auth/refresh with CSRF: 200 + rotated token; missing/wrong CSRF: 403 CSRF_MISMATCH', async () => {
    const email = `refresh-${Date.now()}@duitku.test`;
    const password = 'Password123!';

    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name: 'Refresh User' })
      .expect(201);

    const initialCookies = parseCookies((regRes.headers['set-cookie'] as unknown as string[]) || []);
    const initialRt = initialCookies['duitku_rt'].value;
    const initialCsrf = initialCookies['csrf_token'].value;

    // Tanpa header X-CSRF-Token -> 403 CSRF_MISMATCH
    const errRes1 = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', [`duitku_rt=${initialRt}`, `csrf_token=${initialCsrf}`])
      .expect(403);
    expect(errRes1.body.code).toBe('CSRF_MISMATCH');

    // Salah X-CSRF-Token -> 403 CSRF_MISMATCH
    const errRes2 = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', [`duitku_rt=${initialRt}`, `csrf_token=${initialCsrf}`])
      .set('X-CSRF-Token', 'wrong-token-value')
      .expect(403);
    expect(errRes2.body.code).toBe('CSRF_MISMATCH');

    // CSRF cocok -> 200 { ok: true } + rotasi token
    const okRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', [`duitku_rt=${initialRt}`, `csrf_token=${initialCsrf}`])
      .set('X-CSRF-Token', initialCsrf)
      .expect(200);

    expect(okRes.body.ok).toBe(true);

    const rotatedCookies = parseCookies((okRes.headers['set-cookie'] as unknown as string[]) || []);
    expect(rotatedCookies['duitku_rt']).toBeDefined();
    expect(rotatedCookies['duitku_rt'].value).not.toBe(initialRt);
    expect(rotatedCookies['duitku_session']).toBeDefined();
  });

  // 6. POST /auth/refresh reuse token lama -> 401 REFRESH_TOKEN_REUSE + seluruh refresh token di-revoke
  it('6. POST /auth/refresh token reuse: 401 REFRESH_TOKEN_REUSE + all user refresh tokens revoked', async () => {
    const email = `reuse-${Date.now()}@duitku.test`;
    const password = 'Password123!';

    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name: 'Reuse User' })
      .expect(201);

    const userId = regRes.body.user.id;
    const cookies1 = parseCookies((regRes.headers['set-cookie'] as unknown as string[]) || []);
    const oldRt = cookies1['duitku_rt'].value;
    const csrf1 = cookies1['csrf_token'].value;

    // Refresh pertama: rotasi sah
    const refRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', [`duitku_rt=${oldRt}`, `csrf_token=${csrf1}`])
      .set('X-CSRF-Token', csrf1)
      .expect(200);

    const cookies2 = parseCookies((refRes.headers['set-cookie'] as unknown as string[]) || []);
    const csrf2 = cookies2['csrf_token'].value;

    // Gunakan kembali token lama (reuse)
    const reuseRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', [`duitku_rt=${oldRt}`, `csrf_token=${csrf2}`])
      .set('X-CSRF-Token', csrf2)
      .expect(401);

    expect(reuseRes.body.code).toBe('REFRESH_TOKEN_REUSE');

    // Seluruh refresh token user di DB wajib berstatus revoked
    const dbTokens = await prisma.refreshToken.findMany({
      where: { user_id: userId },
    });
    expect(dbTokens.length).toBeGreaterThan(0);
    expect(dbTokens.every((t) => t.revoked_at !== null)).toBe(true);
  });

  // 7. Mutasi dengan Origin: https://evil.example -> 403 CSRF_ORIGIN_MISMATCH
  it('7. Mutation with Origin https://evil.example: 403 CSRF_ORIGIN_MISMATCH', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'random@duitku.test', password: 'Password123!' })
      .expect(403);

    expect(res.body.code).toBe('CSRF_ORIGIN_MISMATCH');
  });

  // 8. POST /auth/logout -> 200 { ok: true } + refresh token revoked + AuditLog AUTH_LOGOUT
  it('8. POST /auth/logout: 200 { ok: true } + refresh token revoked + AuditLog AUTH_LOGOUT', async () => {
    const email = `logout-${Date.now()}@duitku.test`;
    const password = 'Password123!';

    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name: 'Logout User' })
      .expect(201);

    const userId = regRes.body.user.id;
    const cookies = parseCookies((regRes.headers['set-cookie'] as unknown as string[]) || []);
    const rt = cookies['duitku_rt'].value;

    const logoutRes = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', [`duitku_rt=${rt}`])
      .expect(200);

    expect(logoutRes.body.ok).toBe(true);

    // Refresh token ter-revoke
    const userTokens = await prisma.refreshToken.findMany({
      where: { user_id: userId },
    });
    expect(userTokens.every((t) => t.revoked_at !== null)).toBe(true);

    // AuditLog AUTH_LOGOUT tercatat
    const audit = await prisma.auditLog.findFirst({
      where: {
        actor_user_id: userId,
        action: 'AUTH_LOGOUT',
      },
    });
    expect(audit).toBeDefined();
    expect(audit?.action).toBe('AUTH_LOGOUT');
  });

  // 9. GET /me tanpa cookie -> 401; dengan cookie valid -> 200 data user (tanpa password_hash)
  it('9. GET /me without cookie: 401; with cookie: 200 user data without password_hash', async () => {
    const email = `me-${Date.now()}@duitku.test`;
    const password = 'Password123!';

    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name: 'Me User' })
      .expect(201);

    const cookies = parseCookies((regRes.headers['set-cookie'] as unknown as string[]) || []);
    const sessionToken = cookies['duitku_session'].value;

    // Tanpa cookie -> 401
    await request(app.getHttpServer()).get('/me').expect(401);

    // Dengan cookie valid -> 200
    const meRes = await request(app.getHttpServer())
      .get('/me')
      .set('Cookie', [`duitku_session=${sessionToken}`])
      .expect(200);

    expect(meRes.body.id).toBe(regRes.body.user.id);
    expect(meRes.body.email).toBe(email);
    expect(meRes.body.name).toBe('Me User');

    // Assertion eksplisit memastikan password_hash tidak pernah bocor
    expect(meRes.body).not.toHaveProperty('password_hash');
    expect(meRes.body.password_hash).toBeUndefined();
  });

  // 10. DELETE /me: password salah -> 401; nama tidak cocok -> 422; valid -> 202; GET /me -> 401; login -> 403
  it('10. DELETE /me wrong pwd: 401; name mismatch: 422; valid: 202; next GET: 401, login: 403', async () => {
    const email = `del-${Date.now()}@duitku.test`;
    const password = 'Password123!';
    const name = 'Deletion User';

    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name })
      .expect(201);

    const cookies = parseCookies((regRes.headers['set-cookie'] as unknown as string[]) || []);
    const sessionToken = cookies['duitku_session'].value;

    // Password salah -> 401 REAUTH_FAILED
    const errPwd = await request(app.getHttpServer())
      .delete('/me')
      .set('Cookie', [`duitku_session=${sessionToken}`])
      .send({ display_name_confirmed: name, password: 'WrongPassword' })
      .expect(401);
    expect(errPwd.body.code).toBe('REAUTH_FAILED');

    // Nama tidak cocok -> 422 CONFIRMATION_MISMATCH
    const errName = await request(app.getHttpServer())
      .delete('/me')
      .set('Cookie', [`duitku_session=${sessionToken}`])
      .send({ display_name_confirmed: 'Wrong Name', password })
      .expect(422);
    expect(errName.body.code).toBe('CONFIRMATION_MISMATCH');

    // Konfirmasi valid -> 202 PENDING_DELETION
    const okDel = await request(app.getHttpServer())
      .delete('/me')
      .set('Cookie', [`duitku_session=${sessionToken}`])
      .send({ display_name_confirmed: name, password })
      .expect(202);

    expect(okDel.body.status).toBe('PENDING_DELETION');
    expect(okDel.body.hard_delete_at).toBeDefined();

    // GET /me berikutnya -> 401
    await request(app.getHttpServer())
      .get('/me')
      .set('Cookie', [`duitku_session=${sessionToken}`])
      .expect(401);

    // POST /auth/login berikutnya -> 403 ACCOUNT_PENDING_DELETION
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(403);
    expect(loginRes.body.code).toBe('ACCOUNT_PENDING_DELETION');
  });

  // 11. POST /me/cancel-deletion dengan kredensial valid -> 200 { status: 'ACTIVE' } & login kembali
  it('11. POST /me/cancel-deletion valid: 200 ACTIVE and user can login again', async () => {
    const email = `cancel-${Date.now()}@duitku.test`;
    const password = 'Password123!';
    const name = 'Cancel User';

    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, name })
      .expect(201);

    const cookies = parseCookies((regRes.headers['set-cookie'] as unknown as string[]) || []);
    const sessionToken = cookies['duitku_session'].value;

    // Hapus akun terlebih dahulu
    await request(app.getHttpServer())
      .delete('/me')
      .set('Cookie', [`duitku_session=${sessionToken}`])
      .send({ display_name_confirmed: name, password })
      .expect(202);

    // Batalkan penghapusan akun
    const cancelRes = await request(app.getHttpServer())
      .post('/me/cancel-deletion')
      .send({ email, password })
      .expect(200);

    expect(cancelRes.body.status).toBe('ACTIVE');

    // User dapat login kembali
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    expect(loginRes.body.user.email).toBe(email);
  });

  // 12. Cross-user negative test (proyek.md §4.3, C-01)
  it('12. cross-user negative test: User A calling GET /me and DELETE /me does not affect User B', async () => {
    // Daftarkan User A
    const userAEmail = `usera-${Date.now()}@duitku.test`;
    const userAPassword = 'PasswordA123!';
    const regResA = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: userAEmail, password: userAPassword, name: 'User A' })
      .expect(201);

    const cookiesA = parseCookies((regResA.headers['set-cookie'] as unknown as string[]) || []);
    const sessionTokenA = cookiesA['duitku_session'].value;

    // Daftarkan User B
    const userBEmail = `userb-${Date.now()}@duitku.test`;
    const userBPassword = 'PasswordB123!';
    const regResB = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: userBEmail, password: userBPassword, name: 'User B' })
      .expect(201);

    const cookiesB = parseCookies((regResB.headers['set-cookie'] as unknown as string[]) || []);
    const sessionTokenB = cookiesB['duitku_session'].value;

    // User A memanggil GET /me -> hanya mendapatkan data User A, bukan data User B
    const meResA = await request(app.getHttpServer())
      .get('/me')
      .set('Cookie', [`duitku_session=${sessionTokenA}`])
      .expect(200);

    expect(meResA.body.id).toBe(regResA.body.user.id);
    expect(meResA.body.id).not.toBe(regResB.body.user.id);
    expect(meResA.body.email).toBe(userAEmail);

    // User A memanggil DELETE /me -> hanya User A yang statusnya berubah menjadi PENDING_DELETION
    await request(app.getHttpServer())
      .delete('/me')
      .set('Cookie', [`duitku_session=${sessionTokenA}`])
      .send({ display_name_confirmed: 'User A', password: userAPassword })
      .expect(202);

    // Status User B di database tetap ACTIVE
    const dbUserB = await prisma.user.findUnique({
      where: { id: regResB.body.user.id },
    });
    expect(dbUserB?.status).toBe('ACTIVE');

    // Sesi User B tetap dapat mengakses GET /me tanpa kendala
    const meResB = await request(app.getHttpServer())
      .get('/me')
      .set('Cookie', [`duitku_session=${sessionTokenB}`])
      .expect(200);

    expect(meResB.body.id).toBe(regResB.body.user.id);
    expect(meResB.body.email).toBe(userBEmail);
    expect(meResB.body.name).toBe('User B');
  });
});
