import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CategoriesService } from './categories.service.js';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let prisma: any;

  const user = { userId: '11111111-1111-1111-1111-111111111111', role: 'USER' };
  const profile = {
    id: '22222222-2222-2222-2222-222222222222',
    user_id: user.userId,
    is_default: true,
  };
  const rootCategory = {
    id: '33333333-3333-3333-3333-333333333333',
    financial_profile_id: profile.id,
    user_id: user.userId,
    type: 'EXPENSE' as const,
    parent_id: null,
    name: 'Kopi & Jajan',
    icon: null,
    color: null,
    is_system: false,
    archived: false,
    archived_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    prisma = {
      category: {
        findMany: jest.fn<any>(),
        findFirst: jest.fn<any>(),
        create: jest.fn<any>(),
        update: jest.fn<any>(),
        updateMany: jest.fn<any>(),
      },
      financialProfile: {
        findFirst: jest.fn<any>().mockResolvedValue(profile),
      },
      auditLog: {
        create: jest.fn<any>().mockResolvedValue({ id: 'audit-1' }),
      },
      $transaction: jest.fn<any>(async (fn: any) => fn(prisma)),
    };

    service = new CategoriesService(prisma);
  });

  describe('list', () => {
    it('mengembalikan kategori aktif secara default', async () => {
      prisma.category.findMany.mockResolvedValueOnce([rootCategory]);

      const res = await service.list(user.userId);

      expect(res).toEqual([rootCategory]);
      expect(prisma.category.findMany).toHaveBeenCalledWith({
        where: { user_id: user.userId, archived: false },
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
      });
    });

    it('mengembalikan termasuk kategori arsip jika includeArchived=true', async () => {
      prisma.category.findMany.mockResolvedValueOnce([rootCategory]);

      await service.list(user.userId, true);

      expect(prisma.category.findMany).toHaveBeenCalledWith({
        where: { user_id: user.userId },
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
      });
    });
  });

  describe('create', () => {
    it('membuat kategori root baru dan mencatat audit log', async () => {
      prisma.category.findFirst.mockResolvedValueOnce(null);
      prisma.category.create.mockResolvedValueOnce(rootCategory);

      const res = await service.create(user, { name: '  Kopi & Jajan  ', type: 'EXPENSE' });

      expect(res).toEqual(rootCategory);
      expect(prisma.category.create).toHaveBeenCalledWith({
        data: {
          user_id: user.userId,
          financial_profile_id: profile.id,
          type: 'EXPENSE',
          parent_id: null,
          name: 'Kopi & Jajan',
          is_system: false,
          archived: false,
        },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CATEGORY_CREATE',
            resource_type: 'category',
          }),
        }),
      );
    });

    it('menolak pembuatan subkategori lebih dari 1 tingkat', async () => {
      const subParent = { ...rootCategory, id: '44444444-4444-4444-4444-444444444444', parent_id: rootCategory.id };
      prisma.category.findFirst.mockResolvedValueOnce(subParent);

      await expect(
        service.create(user, {
          name: 'Espresso',
          type: 'EXPENSE',
          parent_id: subParent.id,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('menolak subkategori jika tipe berbeda dengan induk', async () => {
      prisma.category.findFirst.mockResolvedValueOnce(rootCategory);

      await expect(
        service.create(user, {
          name: 'Sub Income',
          type: 'INCOME',
          parent_id: rootCategory.id,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('menolak nama kategori duplikat (case-insensitive)', async () => {
      prisma.category.findFirst.mockResolvedValueOnce(rootCategory);

      await expect(
        service.create(user, { name: 'kopi & jajan', type: 'EXPENSE' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('mengizinkan ubah nama termasuk kategori sistem', async () => {
      const systemCat = { ...rootCategory, name: 'Lainnya', is_system: true };
      const updatedCat = { ...systemCat, name: 'Lain-lain' };
      prisma.category.findFirst
        .mockResolvedValueOnce(systemCat)
        .mockResolvedValueOnce(null);
      prisma.category.update.mockResolvedValueOnce(updatedCat);

      const res = await service.update(user, systemCat.id, { name: 'Lain-lain' });

      expect(res.name).toBe('Lain-lain');
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'CATEGORY_UPDATE' }),
        }),
      );
    });

    it('menolak ubah nama kategori yang sudah diarsipkan', async () => {
      prisma.category.findFirst.mockResolvedValueOnce({ ...rootCategory, archived: true });

      await expect(
        service.update(user, rootCategory.id, { name: 'Baru' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('archive & unarchive', () => {
    it('menolak mengarsipkan kategori sistem', async () => {
      prisma.category.findFirst.mockResolvedValueOnce({ ...rootCategory, is_system: true });

      await expect(service.archive(user, rootCategory.id)).rejects.toThrow(ConflictException);
    });

    it('mengarsipkan kategori root beserta subkategori aktif di bawahnya', async () => {
      const archivedCat = { ...rootCategory, archived: true, archived_at: new Date() };
      prisma.category.findFirst.mockResolvedValueOnce(rootCategory);
      prisma.category.update.mockResolvedValueOnce(archivedCat);
      prisma.category.updateMany.mockResolvedValueOnce({ count: 2 });

      const res = await service.archive(user, rootCategory.id);

      expect(res.archived).toBe(true);
      expect(prisma.category.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: user.userId, parent_id: rootCategory.id, archived: false },
        }),
      );
    });

    it('menolak memulihkan subkategori jika induknya masih diarsipkan', async () => {
      const archivedSub = {
        ...rootCategory,
        id: '55555555-5555-5555-5555-555555555555',
        parent_id: rootCategory.id,
        archived: true,
      };
      prisma.category.findFirst
        .mockResolvedValueOnce(archivedSub)
        .mockResolvedValueOnce({ ...rootCategory, archived: true });

      await expect(service.unarchive(user, archivedSub.id)).rejects.toThrow(ConflictException);
    });

    it('melempar NotFoundException jika kategori tidak ditemukan', async () => {
      prisma.category.findFirst.mockResolvedValueOnce(null);

      await expect(service.archive(user, 'missing-id')).rejects.toThrow(NotFoundException);
    });
  });
});
