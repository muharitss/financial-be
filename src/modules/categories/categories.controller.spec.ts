import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { CategoriesController } from './categories.controller.js';

describe('CategoriesController', () => {
  let controller: CategoriesController;
  let categoriesService: {
    list: jest.Mock<any>;
    create: jest.Mock<any>;
    update: jest.Mock<any>;
    archive: jest.Mock<any>;
    unarchive: jest.Mock<any>;
  };

  beforeEach(() => {
    categoriesService = {
      list: jest.fn(async () => []),
      create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
      archive: jest.fn(async () => ({})),
      unarchive: jest.fn(async () => ({})),
    };
    controller = new CategoriesController(categoriesService as any);
  });

  it('memfilter berdasarkan user_id dan hanya kategori aktif secara default', async () => {
    await controller.list({ userId: 'user-1' });
    expect(categoriesService.list).toHaveBeenCalledWith('user-1', false);
  });

  it('mengembalikan kategori terarsip jika include_archived=true', async () => {
    await controller.list({ userId: 'user-1' }, 'true');
    expect(categoriesService.list).toHaveBeenCalledWith('user-1', true);
  });

  it('mendelegasikan create, update, archive, dan unarchive ke CategoriesService', async () => {
    const user = { userId: 'user-1', role: 'USER' };
    await controller.create(user, { name: 'Investasi', type: 'EXPENSE' });
    expect(categoriesService.create).toHaveBeenCalledWith(user, {
      name: 'Investasi',
      type: 'EXPENSE',
    });

    await controller.update(user, 'cat-1', { name: 'Tabungan' });
    expect(categoriesService.update).toHaveBeenCalledWith(user, 'cat-1', { name: 'Tabungan' });

    await controller.archive(user, 'cat-1');
    expect(categoriesService.archive).toHaveBeenCalledWith(user, 'cat-1');

    await controller.unarchive(user, 'cat-1');
    expect(categoriesService.unarchive).toHaveBeenCalledWith(user, 'cat-1');
  });
});
