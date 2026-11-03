import { PrismaClient } from '@prisma/client';
import { seedDefaultCategories } from './seed/categories.ts';
import { seedDefaultTags } from './seed/tags.ts';

const prisma = new PrismaClient();

export async function main() {
  const nodeEnv = process.env.NODE_ENV || 'development';

  // Seed user dummy hanya di development / test environment
  if (nodeEnv !== 'production') {
    let devUser = await prisma.user.findUnique({
      where: { email: 'dummy-dev@duitku.local' },
    });

    if (!devUser) {
      devUser = await prisma.user.create({
        data: {
          email: 'dummy-dev@duitku.local',
          password_hash: '$argon2id$v=19$m=65536,t=3,p=4$dummyhashfordevseedonly$abcdefghijklmnop',
          name: 'Dummy Dev Seed',
        },
      });
    }

    let defaultProfile = await prisma.financialProfile.findFirst({
      where: {
        user_id: devUser.id,
        is_default: true,
      },
    });

    if (!defaultProfile) {
      defaultProfile = await prisma.financialProfile.create({
        data: {
          user_id: devUser.id,
          name: 'Pribadi',
          is_default: true,
        },
      });
    }

    await seedDefaultCategories(defaultProfile.id, devUser.id, prisma);
    await seedDefaultTags(defaultProfile.id, devUser.id, prisma);
    console.log('Database seeded successfully for profile:', defaultProfile.id);
  }
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
