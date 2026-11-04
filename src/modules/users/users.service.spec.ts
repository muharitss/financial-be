import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('findById', () => {
    it('mengembalikan data publik user jika status ACTIVE', async () => {
      const mockUser = {
        id: 'user-uuid-1',
        name: 'Budi Santoso',
        email: 'budi@example.com',
        picture_url: null,
        role: 'USER',
        created_at: new Date('2026-01-01T00:00:00Z'),
        preferences: {
          timezone: 'Asia/Jakarta',
          theme: 'system',
        },
      };

      prisma.user.findFirst.mockResolvedValue(mockUser);

      const result = await service.findById('user-uuid-1');

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'user-uuid-1',
          status: 'ACTIVE',
        },
        select: {
          id: true,
          name: true,
          email: true,
          picture_url: true,
          role: true,
          created_at: true,
          preferences: {
            select: {
              timezone: true,
              theme: true,
            },
          },
        },
      });

      expect(result).toEqual(mockUser);
    });

    it('mengembalikan null jika user tidak ditemukan atau bukan ACTIVE', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const result = await service.findById('non-existent-user');
      expect(result).toBeNull();
    });

    it('mengembalikan null jika userId kosong', async () => {
      const result = await service.findById('');
      expect(result).toBeNull();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });
  });
});
