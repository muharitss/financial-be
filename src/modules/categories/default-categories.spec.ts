import { jest, describe, it, expect } from '@jest/globals';
import { seedDefaultCategories } from './default-categories.js';

describe('seedDefaultCategories', () => {
  it('AC-1 & AC-2: membuat kategori root dan subkategori dengan tepat 2 system category', async () => {
    const createdItems: any[] = [];
    const tx: any = {
      category: {
        findMany: jest.fn(async (args: any) => {
          // Pertama kali: tidak ada kategori yang sudah ada
          if (!args.where.parent_id) {
            // Dipanggil untuk mengambil root setelah createMany
            return createdItems
              .filter((item) => item.parent_id === null)
              .map((item, idx) => ({ id: `root-${idx}`, name: item.name }));
          }
          return [];
        }),
        createMany: jest.fn(async (args: any) => {
          expect(args.data.length).toBeGreaterThan(0);
          // Validasi tenant isolation: setiap item wajib memiliki user_id
          for (const item of args.data) {
            expect(item.user_id).toBe('user-1');
            expect(item.financial_profile_id).toBe('profile-1');
          }
          createdItems.push(...args.data);
          return { count: args.data.length };
        }),
      },
    };

    await seedDefaultCategories(tx, 'profile-1', 'user-1');

    // 17 root (7 income + 10 expense) + 15 subkategori = 32 total
    expect(createdItems).toHaveLength(32);

    const roots = createdItems.filter((c) => c.parent_id === null);
    expect(roots).toHaveLength(17);

    const subs = createdItems.filter((c) => c.parent_id !== null);
    expect(subs).toHaveLength(15);

    // AC-2: Tepat 2 sistem: Biaya Transfer dan Lainnya
    const systemCategories = createdItems.filter((c) => c.is_system === true);
    expect(systemCategories).toHaveLength(2);
    expect(systemCategories.map((c) => c.name).sort((a, b) => a.localeCompare(b))).toEqual([
      'Biaya Transfer',
      'Lainnya',
    ]);
  });

  it('AC-4: idempoten — dipanggil kedua kali tidak memanggil createMany dengan array kosong', async () => {
    const store: any[] = [];
    let idCounter = 1;

    const tx: any = {
      category: {
        findMany: jest.fn(async (args: any) => {
          expect(args.where.user_id).toBe('user-1');
          if (args.where.parent_id === null) {
            return store.filter((c) => c.parent_id === null);
          }
          return store;
        }),
        createMany: jest.fn(async (args: any) => {
          // Dilarang keras dipanggil dengan array kosong (jebakan tenant isolation)
          expect(args.data.length).toBeGreaterThan(0);
          for (const item of args.data) {
            store.push({ id: `cat-${idCounter++}`, ...item });
          }
          return { count: args.data.length };
        }),
      },
    };

    // Panggilan pertama
    await seedDefaultCategories(tx, 'profile-1', 'user-1');
    expect(store).toHaveLength(32);
    expect(tx.category.createMany).toHaveBeenCalledTimes(2); // 1 kali root, 1 kali subs

    // Panggilan kedua
    tx.category.createMany.mockClear();
    await seedDefaultCategories(tx, 'profile-1', 'user-1');

    // Tidak ada createMany yang dipanggil pada putaran kedua
    expect(tx.category.createMany).not.toHaveBeenCalled();
    expect(store).toHaveLength(32);
  });
});
