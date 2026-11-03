import { PrismaClient } from '@prisma/client';

export const DEFAULT_TAGS = [
  'Kuliah',
  'Liburan',
  'Mendesak',
  'Kebutuhan Kos',
  'Akhir Pekan',
];

export async function seedDefaultTags(
  profileId: string,
  userId: string,
  prismaClient?: PrismaClient,
) {
  const prisma = prismaClient ?? new PrismaClient();
  const shouldDisconnect = !prismaClient;

  try {
    for (const tagName of DEFAULT_TAGS) {
      const existing = await prisma.tag.findFirst({
        where: {
          financial_profile_id: profileId,
          name: tagName,
        },
      });

      if (!existing) {
        await prisma.tag.create({
          data: {
            financial_profile_id: profileId,
            user_id: userId,
            name: tagName,
          },
        });
      }
    }
  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }
}
