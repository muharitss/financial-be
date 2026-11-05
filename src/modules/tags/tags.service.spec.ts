import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { TagsService } from './tags.service.js';

describe('TagsService', () => {
  let service: TagsService;
  let prisma: any;

  const user = { userId: '11111111-1111-1111-1111-111111111111', role: 'USER' };
  const mockProfile = {
    id: '22222222-2222-2222-2222-222222222222',
    user_id: user.userId,
    is_default: true,
  };
  const mockTag = {
    id: '33333333-3333-3333-3333-333333333333',
    financial_profile_id: mockProfile.id,
    user_id: user.userId,
    name: 'Kuliah',
    color: 'blue',
    archived: false,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    prisma = {
      tag: {
        findMany: jest.fn<any>(),
        findFirst: jest.fn<any>(),
        count: jest.fn<any>(),
        create: jest.fn<any>(),
        update: jest.fn<any>(),
      },
      financialProfile: {
        findFirst: jest.fn<any>().mockResolvedValue(mockProfile),
      },
      auditLog: {
        create: jest.fn<any>().mockResolvedValue({ id: 'audit-1' }),
      },
      $transaction: jest.fn<any>(async (fn: any) => fn(prisma)),
    };

    service = new TagsService(prisma);
  });

  describe('list', () => {
    it('mengembalikan tag aktif secara default dengan urutan name asc', async () => {
      prisma.tag.findMany.mockResolvedValueOnce([mockTag]);

      const res = await service.list(user.userId);

      expect(res).toEqual([mockTag]);
      expect(prisma.tag.findMany).toHaveBeenCalledWith({
        where: { user_id: user.userId, archived: false },
        orderBy: { name: 'asc' },
      });
    });

    it('mengembalikan semua tag termasuk yang diarsipkan jika includeArchived true', async () => {
      prisma.tag.findMany.mockResolvedValueOnce([mockTag]);

      const res = await service.list(user.userId, true);

      expect(res).toEqual([mockTag]);
      expect(prisma.tag.findMany).toHaveBeenCalledWith({
        where: { user_id: user.userId },
        orderBy: { name: 'asc' },
      });
    });
  });

  describe('create', () => {
    it('AC-1: berhasil membuat tag baru dengan archived = false dan mencatat audit log TAG_CREATE', async () => {
      prisma.tag.count.mockResolvedValueOnce(5);
      prisma.tag.findFirst.mockResolvedValueOnce(null);
      prisma.tag.create.mockResolvedValueOnce(mockTag);

      const res = await service.create(user, { name: 'Kuliah', color: 'blue' });

      expect(res).toEqual(mockTag);
      expect(prisma.tag.create).toHaveBeenCalledWith({
        data: {
          user_id: user.userId,
          financial_profile_id: mockProfile.id,
          name: 'Kuliah',
          color: 'blue',
          archived: false,
        },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'TAG_CREATE',
          resource_type: 'tag',
          resource_id: mockTag.id,
          actor_user_id: user.userId,
        }),
      });
    });

    it('AC-2: melempar 409 TAG_NAME_TAKEN jika nama tag sudah ada (case-insensitive)', async () => {
      prisma.tag.count.mockResolvedValueOnce(5);
      prisma.tag.findFirst.mockResolvedValueOnce(mockTag);

      await expect(
        service.create(user, { name: 'kuliah', color: 'blue' }),
      ).rejects.toMatchObject({
        response: { code: 'TAG_NAME_TAKEN' },
      });
    });

    it('AC-3: melempar 422 TAG_LIMIT_EXCEEDED jika tag aktif sudah >= 50', async () => {
      prisma.tag.count.mockResolvedValueOnce(50);

      await expect(
        service.create(user, { name: 'Tag51' }),
      ).rejects.toMatchObject({
        response: { code: 'TAG_LIMIT_EXCEEDED' },
      });
    });
  });

  describe('update', () => {
    it('berhasil mengubah tag dan mencatat audit log TAG_UPDATE', async () => {
      prisma.tag.findFirst.mockResolvedValueOnce(mockTag).mockResolvedValueOnce(null);
      const updatedTag = { ...mockTag, name: 'Kuliah Baru', color: 'red' };
      prisma.tag.update.mockResolvedValueOnce(updatedTag);

      const res = await service.update(user, mockTag.id, {
        name: 'Kuliah Baru',
        color: 'red',
      });

      expect(res).toEqual(updatedTag);
      expect(prisma.tag.update).toHaveBeenCalledWith({
        where: { id: mockTag.id, user_id: user.userId },
        data: { name: 'Kuliah Baru', color: 'red' },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'TAG_UPDATE',
          resource_type: 'tag',
          resource_id: mockTag.id,
        }),
      });
    });

    it('melempar 404 TAG_NOT_FOUND jika tag tidak ditemukan', async () => {
      prisma.tag.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.update(user, 'non-existent', { name: 'Baru' }),
      ).rejects.toMatchObject({
        response: { code: 'TAG_NOT_FOUND' },
      });
    });

    it('melempar 409 TAG_ARCHIVED jika tag sudah diarsipkan', async () => {
      prisma.tag.findFirst.mockResolvedValueOnce({ ...mockTag, archived: true });

      await expect(
        service.update(user, mockTag.id, { name: 'Baru' }),
      ).rejects.toMatchObject({
        response: { code: 'TAG_ARCHIVED' },
      });
    });

    it('melempar 409 TAG_NAME_TAKEN jika nama baru bertabrakan dengan tag lain', async () => {
      prisma.tag.findFirst
        .mockResolvedValueOnce(mockTag)
        .mockResolvedValueOnce({ ...mockTag, id: 'other-id', name: 'Existing' });

      await expect(
        service.update(user, mockTag.id, { name: 'Existing' }),
      ).rejects.toMatchObject({
        response: { code: 'TAG_NAME_TAKEN' },
      });
    });
  });

  describe('archive', () => {
    it('AC-5: mengarsipkan tag aktif dan mencatat audit log TAG_ARCHIVE', async () => {
      prisma.tag.findFirst.mockResolvedValueOnce(mockTag);
      const archivedTag = { ...mockTag, archived: true };
      prisma.tag.update.mockResolvedValueOnce(archivedTag);

      const res = await service.archive(user, mockTag.id);

      expect(res.archived).toBe(true);
      expect(prisma.tag.update).toHaveBeenCalledWith({
        where: { id: mockTag.id, user_id: user.userId },
        data: { archived: true },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'TAG_ARCHIVE',
          resource_type: 'tag',
          resource_id: mockTag.id,
        }),
      });
    });

    it('idempoten: jika tag sudah archived, langsung return tanpa update DB atau duplicate audit', async () => {
      const alreadyArchived = { ...mockTag, archived: true };
      prisma.tag.findFirst.mockResolvedValueOnce(alreadyArchived);

      const res = await service.archive(user, mockTag.id);

      expect(res).toEqual(alreadyArchived);
      expect(prisma.tag.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('melempar 404 TAG_NOT_FOUND jika tag tidak ditemukan', async () => {
      prisma.tag.findFirst.mockResolvedValueOnce(null);

      await expect(service.archive(user, 'non-existent')).rejects.toMatchObject({
        response: { code: 'TAG_NOT_FOUND' },
      });
    });
  });
});
