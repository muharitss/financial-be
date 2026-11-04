import {
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as argon2 from '@node-rs/argon2';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestDeletionDto, CancelDeletionDto } from './dto/request-deletion.dto.js';

export interface UserResponse {
  id: string;
  name: string;
  email: string;
  picture_url: string | null;
  role: string;
  created_at: Date;
  preferences: {
    timezone: string;
    theme: string;
  } | null;
}

export interface DeletionMeta {
  ipHash: string;
  userAgent?: string;
}

export interface RequestDeletionResult {
  status: 'PENDING_DELETION';
  hard_delete_at: Date;
}

export interface CancelDeletionResult {
  status: 'ACTIVE';
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(userId: string): Promise<UserResponse | null> {
    if (!userId) {
      return null;
    }

    return this.prisma.user.findFirst({
      where: {
        id: userId,
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
  }

  async requestDeletion(
    userId: string,
    dto: RequestDeletionDto,
    meta: DeletionMeta,
  ): Promise<RequestDeletionResult> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
      },
    });

    if (!user) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        message: 'Sesi tidak valid',
      });
    }

    if (dto.display_name_confirmed.trim().toLowerCase() !== user.name.trim().toLowerCase()) {
      throw new UnprocessableEntityException({
        code: 'CONFIRMATION_MISMATCH',
        message: 'Nama tampilan tidak sesuai',
      });
    }

    const isPasswordValid = await argon2.verify(user.password_hash, dto.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException({
        code: 'REAUTH_FAILED',
        message: 'Password salah',
      });
    }

    const now = new Date();
    const hardDeleteAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await this.prisma.asSystem().$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          status: 'PENDING_DELETION',
          deleted_at: now,
        },
      });

      await tx.refreshToken.updateMany({
        where: { user_id: user.id, revoked_at: null },
        data: { revoked_at: now },
      });

      await tx.transaction.updateMany({
        where: { user_id: user.id, status: 'SCHEDULED' },
        data: {
          status: 'CANCELLED',
          cancelled_at: now,
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'USER_DELETION_REQUESTED',
          actor_user_id: user.id,
          actor_role: user.role,
          resource_type: 'user',
          resource_id: user.id,
          ip_address: meta.ipHash,
          user_agent: meta.userAgent ? meta.userAgent.slice(0, 255) : null,
        },
      });
    });

    return {
      status: 'PENDING_DELETION',
      hard_delete_at: hardDeleteAt,
    };
  }

  async cancelDeletion(
    dto: CancelDeletionDto,
    meta: DeletionMeta,
  ): Promise<CancelDeletionResult> {
    const user = await this.prisma.user.findFirst({
      where: {
        email: dto.email,
        status: 'PENDING_DELETION',
      },
    });

    if (!user) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Email atau password salah',
      });
    }

    const isPasswordValid = await argon2.verify(user.password_hash, dto.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Email atau password salah',
      });
    }

    await this.prisma.asSystem().$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          status: 'ACTIVE',
          deleted_at: null,
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'USER_DELETION_CANCELLED',
          actor_user_id: user.id,
          actor_role: user.role,
          resource_type: 'user',
          resource_id: user.id,
          ip_address: meta.ipHash,
          user_agent: meta.userAgent ? meta.userAgent.slice(0, 255) : null,
        },
      });
    });

    return { status: 'ACTIVE' };
  }
}
