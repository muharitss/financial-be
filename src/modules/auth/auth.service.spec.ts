import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException, ConflictException, HttpException } from '@nestjs/common';
import * as argon2 from '@node-rs/argon2';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

describe('AuthService (Manual Auth)', () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      userPreference: {
        create: jest.fn(),
      },
      financialProfile: {
        create: jest.fn(),
      },
      refreshToken: {
        create: jest.fn().mockResolvedValue({ id: 'rt-1' }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'rt-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (callback) => callback(prisma)),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('mock-jwt-token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('berhasil mendaftar user baru dengan password yang di-hash', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation((args: any) => ({
        id: 'user-uuid-1',
        email: args.data.email,
        name: args.data.name,
        role: 'USER',
        status: 'ACTIVE',
      }));

      const result = await service.register({
        email: 'budi@example.com',
        password: 'passwordRahasia123',
        name: 'Budi',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'budi@example.com' },
      });
      expect(prisma.user.create).toHaveBeenCalled();
      const createArgs = prisma.user.create.mock.calls[0][0];
      expect(createArgs.data.password_hash).not.toBe('passwordRahasia123');
      expect(await argon2.verify(createArgs.data.password_hash, 'passwordRahasia123')).toBe(true);

      expect(prisma.userPreference.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ user_id: 'user-uuid-1' }),
      });
      expect(prisma.financialProfile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ user_id: 'user-uuid-1', is_default: true }),
      });

      expect(result.user.email).toBe('budi@example.com');
      expect(result.sessionToken).toBe('mock-jwt-token');
      expect(result.refreshToken).toBeDefined();
      expect(result.csrfToken).toBeDefined();
    });

    it('melempar ConflictException jika email sudah terdaftar', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'existing-id' });

      await expect(
        service.register({
          email: 'budi@example.com',
          password: 'passwordRahasia123',
          name: 'Budi',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('login', () => {
    it('berhasil login dengan password valid', async () => {
      const passwordHash = await argon2.hash('passwordRahasia123');
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'budi@example.com',
        password_hash: passwordHash,
        name: 'Budi',
        role: 'USER',
        status: 'ACTIVE',
      });

      const result = await service.login(
        { email: 'budi@example.com', password: 'passwordRahasia123' },
        '127.0.0.1',
      );

      expect(result.user.email).toBe('budi@example.com');
      expect(result.sessionToken).toBe('mock-jwt-token');
    });

    it('melempar UnauthorizedException jika password salah', async () => {
      const passwordHash = await argon2.hash('passwordBenar');
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'budi@example.com',
        password_hash: passwordHash,
        role: 'USER',
        status: 'ACTIVE',
      });

      await expect(
        service.login(
          { email: 'budi@example.com', password: 'passwordSalah' },
          '127.0.0.1',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('mengaktifkan cooldown jika salah password >= 5 kali', async () => {
      const passwordHash = await argon2.hash('passwordBenar');
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'budi@example.com',
        password_hash: passwordHash,
        role: 'USER',
        status: 'ACTIVE',
      });

      for (let i = 0; i < 5; i++) {
        await expect(
          service.login(
            { email: 'budi@example.com', password: 'salah' },
            '192.168.1.10',
          ),
        ).rejects.toThrow(UnauthorizedException);
      }

      // Percobaan ke-6 harus ditolak dengan 429
      await expect(
        service.login(
          { email: 'budi@example.com', password: 'salah' },
          '192.168.1.10',
        ),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('refresh', () => {
    it('mendeteksi token reuse dan mencabut semua token user', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-old',
        user_id: 'user-uuid-1',
        revoked_at: new Date(Date.now() - 10000), // Sudah pernah di-revoke
        expires_at: new Date(Date.now() + 100000),
      });

      await expect(
        service.refresh('tokenReuseTest', 'csrf123', 'csrf123'),
      ).rejects.toThrow(UnauthorizedException);

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { user_id: 'user-uuid-1' },
        data: expect.objectContaining({ revoked_at: expect.any(Date) }),
      });
    });
  });
});
