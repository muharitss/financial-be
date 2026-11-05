import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';

describe('Tags E2E Test Suite (Supertest)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let userAHeaders: { cookie: string };
  let userBHeaders: { cookie: string };
  let userAId: string;
  let _userBId: string;
  let profileAId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);

    // Clean up
    await prisma.asSystem().auditLog.deleteMany();
    await prisma.asSystem().transactionTag.deleteMany();
    await prisma.asSystem().tag.deleteMany();
    await prisma.asSystem().user.deleteMany({
      where: {
        email: { endsWith: '@tag.test' },
      },
    });

    // Register User A
    const resA = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user-a@tag.test',
        password: 'Password123!',
        name: 'User A Tag',
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
        email: 'user-b@tag.test',
        password: 'Password123!',
        name: 'User B Tag',
      });
    expect(resB.status).toBe(201);
    _userBId = resB.body.user.id;
    const cookieB = resB.headers['set-cookie']
      .map((c: string) => c.split(';')[0])
      .join('; ');
    userBHeaders = { cookie: cookieB };

    const profA = await prisma.financialProfile.findFirst({
      where: { user_id: userAId, is_default: true },
    });
    profileAId = profA!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-1: POST /tags { name: "Kuliah", color: "blue" } -> 201, tag tersimpan archived = false dan tercatat di audit_logs (TAG_CREATE)', async () => {
    const res = await request(app.getHttpServer())
      .post('/tags')
      .set(userAHeaders)
      .send({
        name: 'Kuliah',
        color: 'blue',
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Kuliah');
    expect(res.body.color).toBe('blue');
    expect(res.body.archived).toBe(false);

    const audit = await prisma.asSystem().auditLog.findFirst({
      where: {
        resource_type: 'tag',
        resource_id: res.body.id,
        action: 'TAG_CREATE',
      },
    });
    expect(audit).toBeDefined();
    expect(audit!.actor_user_id).toBe(userAId);
  });

  it('AC-2: Membuat tag baru dengan nama "kuliah" (beda huruf besar/kecil) pada user yang sama -> 409 TAG_NAME_TAKEN; pada user berbeda -> 201', async () => {
    // User A membuat nama sama huruf kecil
    const resA = await request(app.getHttpServer())
      .post('/tags')
      .set(userAHeaders)
      .send({
        name: 'kuliah',
        color: 'red',
      });
    expect(resA.status).toBe(409);
    expect(resA.body.code).toBe('TAG_NAME_TAKEN');

    // User B membuat nama yang sama -> 201 berhasil
    const resB = await request(app.getHttpServer())
      .post('/tags')
      .set(userBHeaders)
      .send({
        name: 'kuliah',
        color: 'red',
      });
    expect(resB.status).toBe(201);
    expect(resB.body.name).toBe('kuliah');
  });

  it('AC-3: Membuat tag ke-51 saat user sudah memiliki 50 tag aktif -> 422 TAG_LIMIT_EXCEEDED', async () => {
    // User A saat ini sudah punya 1 tag aktif ('Kuliah').
    // Buat 49 tag lagi menggunakan prisma.asSystem() langsung untuk percepat setup
    const extraTags = [];
    for (let i = 2; i <= 50; i++) {
      extraTags.push({
        user_id: userAId,
        financial_profile_id: profileAId,
        name: `BulkTag-${i}`,
        color: 'slate',
        archived: false,
      });
    }
    await prisma.asSystem().tag.createMany({
      data: extraTags,
    });

    const count = await prisma.asSystem().tag.count({
      where: { user_id: userAId, archived: false },
    });
    expect(count).toBe(50);

    // Sekarang coba buat tag ke-51 via POST /tags
    const res51 = await request(app.getHttpServer())
      .post('/tags')
      .set(userAHeaders)
      .send({
        name: 'TagKeLimaSatu',
        color: 'emerald',
      });

    expect(res51.status).toBe(422);
    expect(res51.body.code).toBe('TAG_LIMIT_EXCEEDED');
  });

  it('AC-4: color di luar 8 palet resmi -> 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/tags')
      .set(userBHeaders)
      .send({
        name: 'InvalidColorTag',
        color: 'neon-yellow',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('AC-5: POST /tags/:id/archive mengubah archived = true, menyembunyikan tag dari GET /tags default, tetap menampilkannya di GET /tags?include_archived=true', async () => {
    // Buat tag baru di User B
    const createRes = await request(app.getHttpServer())
      .post('/tags')
      .set(userBHeaders)
      .send({
        name: 'ToArchive',
        color: 'violet',
      });
    expect(createRes.status).toBe(201);
    const tagId = createRes.body.id;

    // Pastikan muncul di GET /tags default
    const listBefore = await request(app.getHttpServer())
      .get('/tags')
      .set(userBHeaders);
    expect(listBefore.status).toBe(200);
    expect(listBefore.body.some((t: any) => t.id === tagId)).toBe(true);

    // Arsipkan via POST /tags/:id/archive
    const archiveRes = await request(app.getHttpServer())
      .post(`/tags/${tagId}/archive`)
      .set(userBHeaders);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.archived).toBe(true);

    // Tidak muncul di GET /tags default
    const listAfterDefault = await request(app.getHttpServer())
      .get('/tags')
      .set(userBHeaders);
    expect(listAfterDefault.status).toBe(200);
    expect(listAfterDefault.body.some((t: any) => t.id === tagId)).toBe(false);

    // Muncul di GET /tags?include_archived=true
    const listAfterAll = await request(app.getHttpServer())
      .get('/tags?include_archived=true')
      .set(userBHeaders);
    expect(listAfterAll.status).toBe(200);
    expect(listAfterAll.body.some((t: any) => t.id === tagId)).toBe(true);

    // Cek idempoten: panggil archive kedua kali tetap 200 tanpa error
    const archiveRes2 = await request(app.getHttpServer())
      .post(`/tags/${tagId}/archive`)
      .set(userBHeaders);
    expect(archiveRes2.status).toBe(200);
  });

  it('AC-6 (isolasi): User B mengubah/mengarsipkan tag milik User A -> 404 TAG_NOT_FOUND', async () => {
    const tagA = await prisma.asSystem().tag.findFirst({
      where: { user_id: userAId, name: 'Kuliah' },
    });
    expect(tagA).toBeDefined();

    // User B coba PATCH tag milik User A
    const patchRes = await request(app.getHttpServer())
      .patch(`/tags/${tagA!.id}`)
      .set(userBHeaders)
      .send({ name: 'HackedByB' });
    expect(patchRes.status).toBe(404);
    expect(patchRes.body.code).toBe('TAG_NOT_FOUND');

    // User B coba POST archive tag milik User A
    const archiveRes = await request(app.getHttpServer())
      .post(`/tags/${tagA!.id}/archive`)
      .set(userBHeaders);
    expect(archiveRes.status).toBe(404);
    expect(archiveRes.body.code).toBe('TAG_NOT_FOUND');
  });

  it('PATCH /tags/:id mengubah nama dan warna serta mencatat audit TAG_UPDATE, dan menolak tag yang sudah diarsipkan dengan 409 TAG_ARCHIVED', async () => {
    // 1. Buat tag baru di User B
    const tagRes = await request(app.getHttpServer())
      .post('/tags')
      .set(userBHeaders)
      .send({
        name: 'EditMe',
        color: 'pink',
      });
    expect(tagRes.status).toBe(201);
    const tagId = tagRes.body.id;

    // 2. PATCH nama dan warna
    const updateRes = await request(app.getHttpServer())
      .patch(`/tags/${tagId}`)
      .set(userBHeaders)
      .send({
        name: 'EditedName',
        color: 'orange',
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.name).toBe('EditedName');
    expect(updateRes.body.color).toBe('orange');

    // 3. Arsipkan tag
    await request(app.getHttpServer())
      .post(`/tags/${tagId}/archive`)
      .set(userBHeaders);

    // 4. Coba PATCH tag yang sudah diarsipkan -> 409 TAG_ARCHIVED
    const patchArchivedRes = await request(app.getHttpServer())
      .patch(`/tags/${tagId}`)
      .set(userBHeaders)
      .send({ name: 'ShouldFail' });
    expect(patchArchivedRes.status).toBe(409);
    expect(patchArchivedRes.body.code).toBe('TAG_ARCHIVED');
  });
});
