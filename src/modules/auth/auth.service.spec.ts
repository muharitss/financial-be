import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException, ConflictException, HttpException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as argon2 from '@node-rs/argon2';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ScheduledTransactionService } from '../transactions/scheduled-transaction.service.js';

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
        create: jest.fn().mockResolvedValue({ id: 'profile-uuid-1', user_id: 'user-uuid-1', is_default: true }),
      },
      category: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 17 }),
      },
      refreshToken: {
        create: jest.fn().mockResolvedValue({ id: 'rt-1' }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'rt-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      $transaction: jest.fn(async (callback) => callback(prisma)),
      asSystem: jest.fn(() => prisma),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('mock-jwt-token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ScheduledTransactionService,
          useValue: {
            processDueForUser: jest.fn().mockResolvedValue(undefined),
          },
        },
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
      expect(prisma.category.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ user_id: 'user-uuid-1', financial_profile_id: 'profile-uuid-1' }),
        }),
      );
      expect(prisma.category.createMany).toHaveBeenCalled();

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

    it('menolak login dengan 403 ACCOUNT_PENDING_DELETION jika user berstatus PENDING_DELETION', async () => {
      const passwordHash = await argon2.hash('passwordBenar');
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'budi@example.com',
        password_hash: passwordHash,
        role: 'USER',
        status: 'PENDING_DELETION',
      });

      await expect(
        service.login(
          { email: 'budi@example.com', password: 'passwordBenar' },
          '127.0.0.1',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('refresh', () => {
    it('menolak refresh jika token CSRF tidak cocok atau tidak ada', async () => {
      await expect(
        service.refresh('rawToken', 'cookieToken', 'mismatchedToken'),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.refresh('rawToken', undefined, 'headerToken'),
      ).rejects.toThrow(ForbiddenException);
    });

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

    it('tidak mencabut semua token jika token baru saja dirotasi dalam grace window (<15s)', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-old',
        user_id: 'user-uuid-1',
        replaced_by_id: 'rt-new',
        revoked_at: new Date(Date.now() - 2000),
        expires_at: new Date(Date.now() + 100000),
      });

      await expect(
        service.refresh('concurrentToken', 'csrf123', 'csrf123'),
      ).rejects.toThrow(UnauthorizedException);

      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('berhasil merotasi refresh token dan session token jika valid', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-old',
        user_id: 'user-uuid-1',
        revoked_at: null,
        expires_at: new Date(Date.now() + 100000),
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        role: 'USER',
        status: 'ACTIVE',
      });

      const result = await service.refresh('validRawToken', 'csrf123', 'csrf123');

      expect(result.sessionToken).toBe('mock-jwt-token');
      expect(result.refreshToken).toBeDefined();
      expect(result.csrfToken).toBeDefined();
      expect(prisma.refreshToken.create).toHaveBeenCalled();
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-old' },
        data: expect.objectContaining({
          revoked_at: expect.any(Date),
          replaced_by_id: 'rt-1',
        }),
      });
    });
  });

  describe('logout', () => {
    it('mengembalikan { ok: true } jika dipanggil tanpa refresh token', async () => {
      const result = await service.logout();
      expect(result).toEqual({ ok: true });
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('mencabut token dan mencatat AuditLog dengan hashed IP dan user agent', async () => {
      const rawToken = 'my-refresh-token';
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const clientIp = '192.168.1.1';
      const expectedHashedIp = createHash('sha256').update(clientIp).digest('hex');
      const userAgent = 'Mozilla/5.0 TestBrowser';

      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-uuid-1',
        user_id: 'user-uuid-1',
        token_hash: tokenHash,
        revoked_at: null,
      });

      const result = await service.logout(rawToken, clientIp, userAgent);
      expect(result).toEqual({ ok: true });
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'token-uuid-1' },
        data: expect.objectContaining({ revoked_at: expect.any(Date) }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: 'AUTH_LOGOUT',
          actor_user_id: 'user-uuid-1',
          resource_type: 'session',
          resource_id: 'token-uuid-1',
          ip_address: expectedHashedIp,
          user_agent: userAgent,
        },
      });
    });

    it('tidak mencatat audit log ganda jika token sudah di-revoke sebelumnya', async () => {
      const rawToken = 'my-revoked-token';
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');

      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-uuid-1',
        user_id: 'user-uuid-1',
        token_hash: tokenHash,
        revoked_at: new Date(),
      });

      const result = await service.logout(rawToken, '127.0.0.1');
      expect(result).toEqual({ ok: true });
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('tetap idempoten mengembalikan { ok: true } jika token tidak ditemukan di DB', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      const result = await service.logout('unknown-token', '127.0.0.1');
      expect(result).toEqual({ ok: true });
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
