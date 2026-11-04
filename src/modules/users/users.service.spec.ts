import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import {
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as argon2 from '@node-rs/argon2';
import { UsersService } from './users.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: {
        updateMany: jest.fn(),
      },
      transaction: {
        updateMany: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      asSystem: jest.fn(() => prisma),
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

  describe('requestDeletion', () => {
    it('berhasil memproses penghapusan akun: status PENDING_DELETION, revoke token, batalkan tx scheduled, tulis audit log', async () => {
      const passwordHash = await argon2.hash('MyPassword123');
      const mockUser = {
        id: 'user-1',
        name: 'Budi Santoso',
        role: 'USER',
        password_hash: passwordHash,
      };

      prisma.user.findFirst.mockResolvedValue(mockUser);

      const result = await service.requestDeletion(
        'user-1',
        {
          display_name_confirmed: '  Budi Santoso  ',
          password: 'MyPassword123',
        },
        {
          ipHash: 'ip-hash-abc',
          userAgent: 'Mozilla/5.0 Test Browser',
        },
      );

      expect(result.status).toBe('PENDING_DELETION');
      expect(result.hard_delete_at).toBeInstanceOf(Date);
      expect(result.hard_delete_at.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: expect.objectContaining({
            status: 'PENDING_DELETION',
          }),
        }),
      );

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1', revoked_at: null },
        data: expect.objectContaining({
          revoked_at: expect.any(Date),
        }),
      });

      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1', status: 'SCHEDULED' },
        data: expect.objectContaining({
          status: 'CANCELLED',
          cancelled_at: expect.any(Date),
        }),
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'USER_DELETION_REQUESTED',
          actor_user_id: 'user-1',
          actor_role: 'USER',
          resource_type: 'user',
          resource_id: 'user-1',
          ip_address: 'ip-hash-abc',
          user_agent: 'Mozilla/5.0 Test Browser',
        }),
      });
    });

    it('melempar UnauthorizedException jika user tidak ditemukan atau tidak aktif', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.requestDeletion(
          'user-unknown',
          { display_name_confirmed: 'Budi', password: 'pass' },
          { ipHash: 'ip' },
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('melempar UnprocessableEntityException jika display_name_confirmed tidak cocok', async () => {
      const passwordHash = await argon2.hash('MyPassword123');
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        name: 'Budi Santoso',
        role: 'USER',
        password_hash: passwordHash,
      });

      await expect(
        service.requestDeletion(
          'user-1',
          { display_name_confirmed: 'Salah Nama', password: 'MyPassword123' },
          { ipHash: 'ip' },
        ),
      ).rejects.toThrow(UnprocessableEntityException);

      try {
        await service.requestDeletion(
          'user-1',
          { display_name_confirmed: 'Salah Nama', password: 'MyPassword123' },
          { ipHash: 'ip' },
        );
      } catch (err: any) {
        expect(err.getResponse()).toEqual({
          code: 'CONFIRMATION_MISMATCH',
          message: 'Nama tampilan tidak sesuai',
        });
      }
    });

    it('melempar UnauthorizedException jika re-auth password salah', async () => {
      const passwordHash = await argon2.hash('MyPassword123');
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        name: 'Budi Santoso',
        role: 'USER',
        password_hash: passwordHash,
      });

      await expect(
        service.requestDeletion(
          'user-1',
          { display_name_confirmed: 'Budi Santoso', password: 'WrongPassword' },
          { ipHash: 'ip' },
        ),
      ).rejects.toThrow(UnauthorizedException);

      try {
        await service.requestDeletion(
          'user-1',
          { display_name_confirmed: 'Budi Santoso', password: 'WrongPassword' },
          { ipHash: 'ip' },
        );
      } catch (err: any) {
        expect(err.getResponse()).toEqual({
          code: 'REAUTH_FAILED',
          message: 'Password salah',
        });
      }
    });
  });

  describe('cancelDeletion', () => {
    it('berhasil membatalkan penghapusan: status ACTIVE, deleted_at null, catat audit log', async () => {
      const passwordHash = await argon2.hash('MyPassword123');
      const mockUser = {
        id: 'user-1',
        email: 'budi@example.com',
        role: 'USER',
        status: 'PENDING_DELETION',
        password_hash: passwordHash,
      };

      prisma.user.findFirst.mockResolvedValue(mockUser);

      const result = await service.cancelDeletion(
        { email: 'budi@example.com', password: 'MyPassword123' },
        { ipHash: 'ip-hash-xyz', userAgent: 'Browser' },
      );

      expect(result).toEqual({ status: 'ACTIVE' });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          status: 'ACTIVE',
          deleted_at: null,
        },
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'USER_DELETION_CANCELLED',
          actor_user_id: 'user-1',
          actor_role: 'USER',
          resource_type: 'user',
          resource_id: 'user-1',
          ip_address: 'ip-hash-xyz',
          user_agent: 'Browser',
        }),
      });
    });

    it('melempar UnauthorizedException jika user dengan status PENDING_DELETION tidak ditemukan', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.cancelDeletion(
          { email: 'notfound@example.com', password: 'pass' },
          { ipHash: 'ip' },
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('melempar UnauthorizedException jika password pembatalan salah', async () => {
      const passwordHash = await argon2.hash('CorrectPass');
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        email: 'budi@example.com',
        password_hash: passwordHash,
        status: 'PENDING_DELETION',
      });

      await expect(
        service.cancelDeletion(
          { email: 'budi@example.com', password: 'WrongPass' },
          { ipHash: 'ip' },
        ),
      ).rejects.toThrow(UnauthorizedException);

      try {
        await service.cancelDeletion(
          { email: 'budi@example.com', password: 'WrongPass' },
          { ipHash: 'ip' },
        );
      } catch (err: any) {
        expect(err.getResponse()).toEqual({
          code: 'INVALID_CREDENTIALS',
          message: 'Email atau password salah',
        });
      }
    });
  });
});
