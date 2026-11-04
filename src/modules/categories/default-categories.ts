import { Prisma, CategoryType } from '@prisma/client';

export interface DefaultCategoryDef {
  name: string;
  type: CategoryType;
  is_system?: boolean;
  subcategories?: string[];
}

export const DEFAULT_CATEGORIES: DefaultCategoryDef[] = [
  // Income (7)
  { name: 'Uang Saku', type: CategoryType.INCOME },
  { name: 'Gaji', type: CategoryType.INCOME },
  { name: 'Beasiswa', type: CategoryType.INCOME },
  { name: 'Freelance', type: CategoryType.INCOME },
  { name: 'Bonus', type: CategoryType.INCOME },
  { name: 'Hadiah', type: CategoryType.INCOME },
  { name: 'Pendapatan Lain', type: CategoryType.INCOME },

  // Expense (10 termasuk 2 sistem: Biaya Transfer & Lainnya)
  {
    name: 'Makanan & Minuman',
    type: CategoryType.EXPENSE,
    subcategories: ['Sarapan', 'Makan Siang', 'Makan Malam', 'Camilan', 'Kopi & Teh'],
  },
  {
    name: 'Transportasi',
    type: CategoryType.EXPENSE,
    subcategories: ['Ojek Online', 'Bensin', 'Parkir', 'Transportasi Umum'],
  },
  { name: 'Belanja', type: CategoryType.EXPENSE },
  {
    name: 'Pendidikan',
    type: CategoryType.EXPENSE,
    subcategories: ['Buku', 'Kursus', 'Alat Tulis'],
  },
  { name: 'Kesehatan', type: CategoryType.EXPENSE },
  {
    name: 'Hiburan',
    type: CategoryType.EXPENSE,
    subcategories: ['Streaming', 'Game', 'Jalan-jalan'],
  },
  { name: 'Tagihan', type: CategoryType.EXPENSE },
  { name: 'Tempat Tinggal', type: CategoryType.EXPENSE },
  { name: 'Biaya Transfer', type: CategoryType.EXPENSE, is_system: true },
  { name: 'Lainnya', type: CategoryType.EXPENSE, is_system: true },
];

export async function seedDefaultCategories(
  tx: Prisma.TransactionClient,
  profileId: string,
  userId: string,
): Promise<void> {
  // 1. Ambil kategori yang sudah ada untuk user dan profil ini
  const existingCategories = await tx.category.findMany({
    where: {
      user_id: userId,
      financial_profile_id: profileId,
    },
    select: {
      id: true,
      name: true,
      parent_id: true,
    },
  });

  const existingRootNames = new Set(
    existingCategories
      .filter((c) => c.parent_id === null)
      .map((c) => c.name),
  );

  // 2. Kumpulkan kategori root yang belum ada
  const missingRoots = DEFAULT_CATEGORIES.filter(
    (cat) => !existingRootNames.has(cat.name),
  ).map((cat) => ({
    user_id: userId,
    financial_profile_id: profileId,
    name: cat.name,
    type: cat.type,
    is_system: cat.is_system ?? false,
    parent_id: null,
  }));

  if (missingRoots.length > 0) {
    await tx.category.createMany({
      data: missingRoots,
    });
  }

  // 3. Ambil ulang root kategori untuk memetakan parent_id subkategori
  const rootCategories = await tx.category.findMany({
    where: {
      user_id: userId,
      financial_profile_id: profileId,
      parent_id: null,
    },
    select: {
      id: true,
      name: true,
    },
  });

  const rootIdMap = new Map(rootCategories.map((r) => [r.name, r.id]));

  const existingSubs = new Set(
    existingCategories
      .filter((c) => c.parent_id !== null)
      .map((c) => `${c.parent_id}:${c.name}`),
  );

  const missingSubs: Array<{
    user_id: string;
    financial_profile_id: string;
    name: string;
    type: CategoryType;
    parent_id: string;
    is_system: boolean;
  }> = [];

  for (const cat of DEFAULT_CATEGORIES) {
    if (cat.subcategories && cat.subcategories.length > 0) {
      const parentId = rootIdMap.get(cat.name);
      if (!parentId) continue;

      for (const subName of cat.subcategories) {
        if (!existingSubs.has(`${parentId}:${subName}`)) {
          missingSubs.push({
            user_id: userId,
            financial_profile_id: profileId,
            name: subName,
            type: cat.type,
            parent_id: parentId,
            is_system: false,
          });
        }
      }
    }
  }

  if (missingSubs.length > 0) {
    await tx.category.createMany({
      data: missingSubs,
    });
  }
}
