import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('@nestjs/throttler', () => ({
  Throttle: () => () => {},
  SkipThrottle: () => () => {},
}));

const { Test } = await import('@nestjs/testing');
const { UnauthorizedException } = await import('@nestjs/common');
const { UsersController } = await import('./users.controller.js');
const { UsersService } = await import('./users.service.js');

describe('UsersController', () => {
  let controller: any;
  let service: any;

  beforeEach(async () => {
    service = {
      findById: jest.fn(),
      requestDeletion: jest.fn(),
      cancelDeletion: jest.fn(),
    };

    const module = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get(UsersController);
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

  describe('DELETE /me', () => {
    it('memproses permintaan penghapusan, menghapus cookie sesi, dan return 202 status PENDING_DELETION', async () => {
      const mockResult = {
        status: 'PENDING_DELETION',
        hard_delete_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      };
      service.requestDeletion.mockResolvedValue(mockResult);

      const mockRes: any = {
        clearCookie: jest.fn(),
      };
      const mockReq: any = {
        ip: '127.0.0.1',
        headers: {
          'user-agent': 'JestTestRunner',
        },
      };

      const dto = {
        display_name_confirmed: 'Budi Santoso',
        password: 'Password123',
      };

      const result = await controller.deleteMe(
        { userId: 'user-uuid-1' },
        dto,
        mockReq,
        mockRes,
      );

      expect(service.requestDeletion).toHaveBeenCalledWith(
        'user-uuid-1',
        dto,
        expect.objectContaining({
          ipHash: expect.any(String),
          userAgent: 'JestTestRunner',
        }),
      );

      expect(mockRes.clearCookie).toHaveBeenCalledWith(
        '__Host-duitku_session',
        expect.any(Object),
      );
      expect(mockRes.clearCookie).toHaveBeenCalledWith(
        'duitku_session',
        expect.any(Object),
      );
      expect(mockRes.clearCookie).toHaveBeenCalledWith(
        '__Host-duitku_rt',
        expect.any(Object),
      );
      expect(mockRes.clearCookie).toHaveBeenCalledWith(
        'duitku_rt',
        expect.any(Object),
      );
      expect(mockRes.clearCookie).toHaveBeenCalledWith(
        'csrf_token',
        expect.any(Object),
      );

      expect(result).toEqual(mockResult);
    });
  });

  describe('POST /me/cancel-deletion', () => {
    it('memproses pembatalan penghapusan dan return status ACTIVE', async () => {
      service.cancelDeletion.mockResolvedValue({ status: 'ACTIVE' });

      const mockReq: any = {
        ip: '192.168.1.1',
        headers: {
          'user-agent': 'MobileApp',
        },
      };

      const dto = {
        email: 'budi@example.com',
        password: 'Password123',
      };

      const result = await controller.cancelDeletion(dto, mockReq);

      expect(service.cancelDeletion).toHaveBeenCalledWith(
        dto,
        expect.objectContaining({
          ipHash: expect.any(String),
          userAgent: 'MobileApp',
        }),
      );

      expect(result).toEqual({ status: 'ACTIVE' });
    });
  });
});
