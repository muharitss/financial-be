import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from '@node-rs/argon2';
import { randomBytes, createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RegisterDto, LoginDto } from './dto/auth.dto.js';

interface CooldownEntry {
  failures: number;
  firstAttempt: number;
  lockedUntil?: number;
}

@Injectable()
export class AuthService {
  // In-memory brute force tracker for failed login attempts
  private readonly loginAttempts = new Map<string, CooldownEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  private checkCooldown(key: string): void {
    const record = this.loginAttempts.get(key);
    if (!record) return;

    const now = Date.now();
    if (record.lockedUntil && now < record.lockedUntil) {
      const waitSeconds = Math.ceil((record.lockedUntil - now) / 1000);
      throw new HttpException(
        {
          code: 'LOGIN_COOLDOWN',
          message: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${waitSeconds} detik.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (now - record.firstAttempt > 15 * 60 * 1000) {
      this.loginAttempts.delete(key);
    }
  }

  private recordLoginFailure(key: string): void {
    const now = Date.now();
    const record = this.loginAttempts.get(key);

    if (!record || now - record.firstAttempt > 15 * 60 * 1000) {
      this.loginAttempts.set(key, { failures: 1, firstAttempt: now });
      return;
    }

    record.failures += 1;
    if (record.failures >= 5) {
      record.lockedUntil = now + 15 * 60 * 1000;
    }
  }

  private clearLoginAttempts(key: string): void {
    this.loginAttempts.delete(key);
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'Email sudah terdaftar',
      });
    }

    const passwordHash = await argon2.hash(dto.password);

    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: dto.email,
          password_hash: passwordHash,
          name: dto.name,
        },
      });

      await tx.userPreference.create({
        data: {
          user_id: newUser.id,
          timezone: 'Asia/Jakarta',
          theme: 'system',
        },
      });

      await tx.financialProfile.create({
        data: {
          user_id: newUser.id,
          name: 'Pribadi',
          is_default: true,
        },
      });

      return newUser;
    });

    const tokens = await this.issueTokens(user.id, user.role);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      ...tokens,
    };
  }

  async login(dto: LoginDto, clientIp: string) {
    const rateLimitKey = `${clientIp}:${dto.email}`;
    this.checkCooldown(rateLimitKey);

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      this.recordLoginFailure(rateLimitKey);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Email atau password salah',
      });
    }

    const isMatch = await argon2.verify(user.password_hash, dto.password);
    if (!isMatch) {
      this.recordLoginFailure(rateLimitKey);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Email atau password salah',
      });
    }

    if (user.status === 'PENDING_DELETION') {
      throw new ForbiddenException({
        code: 'ACCOUNT_PENDING_DELETION',
        message: 'Akun sedang dalam masa tenggang penghapusan',
      });
    }

    this.clearLoginAttempts(rateLimitKey);
    this.onLoginPostProcess(user.id);

    const tokens = await this.issueTokens(user.id, user.role);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      ...tokens,
    };
  }

  async refresh(rawRefreshToken: string, csrfCookie?: string, csrfHeader?: string) {
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      throw new ForbiddenException({
        code: 'CSRF_MISMATCH',
        message: 'Token CSRF tidak valid',
      });
    }

    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const existing = await this.prisma.refreshToken.findUnique({
      where: { token_hash: tokenHash },
    });

    if (!existing) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token tidak valid',
      });
    }

    if (existing.revoked_at !== null) {
      // Reuse detected: revoke all tokens for this user immediately
      await this.prisma.refreshToken.updateMany({
        where: { user_id: existing.user_id },
        data: { revoked_at: new Date() },
      });
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REUSE',
        message: 'Indikasi penggunaan token ulang terdeteksi. Silakan login kembali.',
      });
    }

    if (existing.expires_at < new Date()) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Sesi telah berakhir. Silakan login kembali.',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: existing.user_id },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'USER_INACTIVE',
        message: 'Akun pengguna tidak aktif',
      });
    }

    // Rotate refresh token
    const newRawRefreshToken = randomBytes(32).toString('base64url');
    const newTokenHash = createHash('sha256').update(newRawRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: {
          user_id: user.id,
          token_hash: newTokenHash,
          expires_at: expiresAt,
        },
      });

      await tx.refreshToken.update({
        where: { id: existing.id },
        data: {
          revoked_at: new Date(),
          replaced_by_id: created.id,
        },
      });
    });

    const sessionToken = this.jwtService.sign({
      sub: user.id,
      role: user.role,
    });
    const csrfToken = randomBytes(32).toString('base64url');

    return {
      sessionToken,
      refreshToken: newRawRefreshToken,
      csrfToken,
    };
  }

  async logout(rawRefreshToken?: string) {
    if (rawRefreshToken) {
      const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
      await this.prisma.refreshToken
        .update({
          where: { token_hash: tokenHash },
          data: { revoked_at: new Date() },
        })
        .catch(() => {
          // shortcut: silent catch if token already deleted or missing, clean logout is goal
        });
    }
    return { ok: true };
  }

  onLoginPostProcess(_userId: string): void {
    // shortcut: stub for TASK-045 scheduled posting on login, will be hooked in phase 4
  }

  private async issueTokens(userId: string, role: string) {
    const sessionToken = this.jwtService.sign({
      sub: userId,
      role,
    });

    const rawRefreshToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: {
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
      },
    });

    const csrfToken = randomBytes(32).toString('base64url');

    return {
      sessionToken,
      refreshToken: rawRefreshToken,
      csrfToken,
    };
  }
}
