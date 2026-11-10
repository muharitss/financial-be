import {
  Injectable,
  Optional,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from '@node-rs/argon2';
import { randomBytes, createHash } from 'node:crypto';
import { LoginCooldownTracker } from '../../common/throttler/throttler.config.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ScheduledTransactionService } from '../transactions/scheduled-transaction.service.js';
import { BudgetRolloverService } from '../budgets/budget-rollover.service.js';
import type { RegisterDto, LoginDto } from './dto/auth.dto.js';
import { seedDefaultCategories } from '../categories/default-categories.js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly cooldown = new LoginCooldownTracker();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    @Optional() private readonly scheduledTransactionService?: ScheduledTransactionService,
    @Optional() private readonly budgetRolloverService?: BudgetRolloverService,
  ) {}

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

      const profile = await tx.financialProfile.create({
        data: {
          user_id: newUser.id,
          name: 'Pribadi',
          is_default: true,
        },
      });

      await seedDefaultCategories(tx, profile.id, newUser.id);

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
    this.cooldown.check(rateLimitKey);

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      this.cooldown.recordFailure(rateLimitKey);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Email atau password salah',
      });
    }

    const isMatch = await argon2.verify(user.password_hash, dto.password);
    if (!isMatch) {
      this.cooldown.recordFailure(rateLimitKey);
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

    this.cooldown.clear(rateLimitKey);
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
    const existing = await this.prisma.asSystem().refreshToken.findUnique({
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

    await this.prisma.asSystem().$transaction(async (tx) => {
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

  async logout(rawRefreshToken?: string, clientIp?: string, userAgent?: string) {
    if (rawRefreshToken) {
      const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
      const token = await this.prisma
        .asSystem()
        .refreshToken.findUnique({
          where: { token_hash: tokenHash },
        })
        .catch(() => null);

      if (token && !token.revoked_at) {
        const hashedIp = clientIp
          ? createHash('sha256').update(clientIp).digest('hex')
          : null;
        const truncatedUserAgent = userAgent ? userAgent.slice(0, 255) : null;

        await this.prisma
          .asSystem()
          .$transaction(async (tx) => {
            await tx.refreshToken.update({
              where: { id: token.id },
              data: { revoked_at: new Date() },
            });

            await tx.auditLog.create({
              data: {
                action: 'AUTH_LOGOUT',
                actor_user_id: token.user_id,
                resource_type: 'session',
                resource_id: token.id,
                ip_address: hashedIp,
                user_agent: truncatedUserAgent,
              },
            });
          })
          .catch(() => {
            // shortcut: silent catch if revocation/audit fails, clean logout is goal
          });
      }
    }
    return { ok: true };
  }

  onLoginPostProcess(userId: string): void {
    this.scheduledTransactionService
      ?.processDueForUser(userId)
      .catch((err) => {
        this.logger.warn(
          `Failed to process scheduled transactions on login for user ${userId}: ${err.message}`,
        );
      });

    this.budgetRolloverService
      ?.processMonthTurnForUser(userId)
      .catch((err) => {
        this.logger.warn(
          `Failed to process budget rollover on login for user ${userId}: ${err.message}`,
        );
      });
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
