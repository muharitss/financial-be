import { PrismaClient, CategoryType } from '@prisma/client';

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
  profileId: string,
  userId: string,
  prismaClient?: PrismaClient,
) {
  const prisma = prismaClient ?? new PrismaClient();
  const shouldDisconnect = !prismaClient;

  try {
    for (const catDef of DEFAULT_CATEGORIES) {
      let category = await prisma.category.findFirst({
        where: {
          financial_profile_id: profileId,
          parent_id: null,
          name: catDef.name,
        },
      });

      if (!category) {
        category = await prisma.category.create({
          data: {
            financial_profile_id: profileId,
            user_id: userId,
            name: catDef.name,
            type: catDef.type,
            is_system: catDef.is_system ?? false,
          },
        });
      }

      if (catDef.subcategories && catDef.subcategories.length > 0) {
        for (const subName of catDef.subcategories) {
          const existingSub = await prisma.category.findFirst({
            where: {
              financial_profile_id: profileId,
              parent_id: category.id,
              name: subName,
            },
          });

          if (!existingSub) {
            await prisma.category.create({
              data: {
                financial_profile_id: profileId,
                user_id: userId,
                name: subName,
                type: catDef.type,
                parent_id: category.id,
                is_system: false,
              },
            });
          }
        }
      }
    }
  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }
}
