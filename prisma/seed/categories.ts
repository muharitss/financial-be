import { PrismaClient, Prisma } from '@prisma/client';
import {
  DEFAULT_CATEGORIES,
  seedDefaultCategories as seedCategoriesCore,
  type DefaultCategoryDef,
} from '../../src/modules/categories/default-categories.ts';

export { DEFAULT_CATEGORIES, type DefaultCategoryDef };

export async function seedDefaultCategories(
  profileId: string,
  userId: string,
  prismaClient?: PrismaClient,
) {
  const prisma = prismaClient ?? new PrismaClient();
  const shouldDisconnect = !prismaClient;

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await seedCategoriesCore(tx, profileId, userId);
    });
  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }
}
