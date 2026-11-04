import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

describe('UsersController', () => {
  let controller: UsersController;
  let service: any;

  beforeEach(async () => {
    service = {
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  describe('GET /me', () => {
    it('mengembalikan profile user jika user aktif', async () => {
      const mockProfile = {
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

      service.findById.mockResolvedValue(mockProfile);

      const result = await controller.getMe({ userId: 'user-uuid-1' });
      expect(service.findById).toHaveBeenCalledWith('user-uuid-1');
      expect(result).toEqual(mockProfile);
    });

    it('melempar UnauthorizedException SESSION_INVALID jika user tidak ditemukan atau PENDING_DELETION', async () => {
      service.findById.mockResolvedValue(null);

      await expect(
        controller.getMe({ userId: 'pending-or-deleted-user' }),
      ).rejects.toThrow(UnauthorizedException);

      try {
        await controller.getMe({ userId: 'pending-or-deleted-user' });
      } catch (err: any) {
        expect(err).toBeInstanceOf(UnauthorizedException);
        expect(err.getResponse()).toEqual({
          code: 'SESSION_INVALID',
          message: 'Sesi tidak valid',
        });
      }
    });
  });
});
