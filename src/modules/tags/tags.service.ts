import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  type CreateTagDto,
  type UpdateTagDto,
  type TagResponse,
} from './dto/tag.dto.js';

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, includeArchived = false): Promise<TagResponse[]> {
    return this.prisma.tag.findMany({
      where: {
        user_id: userId,
        ...(includeArchived ? {} : { archived: false }),
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async create(
    user: { userId: string; role?: string },
    dto: CreateTagDto,
  ): Promise<TagResponse> {
    return this.prisma.$transaction(async (tx) => {
      const profile =
        (await tx.financialProfile.findFirst({
          where: { user_id: user.userId, is_default: true },
        })) ??
        (await tx.financialProfile.findFirst({
          where: { user_id: user.userId },
        }));

      if (!profile) {
        throw new NotFoundException({
          code: 'PROFILE_NOT_FOUND',
          message: 'Profil keuangan tidak ditemukan',
        });
      }

      const activeCount = await tx.tag.count({
        where: { user_id: user.userId, archived: false },
      });

      if (activeCount >= 50) {
        throw new UnprocessableEntityException({
          code: 'TAG_LIMIT_EXCEEDED',
          message: 'Maksimal 50 tag per pengguna',
        });
      }

      const trimmedName = dto.name.trim();

      const existing = await tx.tag.findFirst({
        where: {
          user_id: user.userId,
          financial_profile_id: profile.id,
          name: { equals: trimmedName, mode: 'insensitive' },
        },
      });

      if (existing) {
        throw new ConflictException({
          code: 'TAG_NAME_TAKEN',
          message: 'Nama tag sudah dipakai',
        });
      }

      try {
        const tag = await tx.tag.create({
          data: {
            user_id: user.userId,
            financial_profile_id: profile.id,
            name: trimmedName,
            color: dto.color ?? null,
            archived: false,
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'TAG_CREATE',
            resource_type: 'tag',
            resource_id: tag.id,
            actor_user_id: user.userId,
            actor_role: user.role ?? 'USER',
            after: tag as unknown as Prisma.InputJsonValue,
          },
        });

        return tag;
      } catch (err: any) {
        if (err.code === 'P2002') {
          throw new ConflictException({
            code: 'TAG_NAME_TAKEN',
            message: 'Nama tag sudah dipakai',
          });
        }
        throw err;
      }
    });
  }

  async update(
    user: { userId: string; role?: string },
    tagId: string,
    dto: UpdateTagDto,
  ): Promise<TagResponse> {
    return this.prisma.$transaction(async (tx) => {
      const tag = await tx.tag.findFirst({
        where: { id: tagId, user_id: user.userId },
      });

      if (!tag) {
        throw new NotFoundException({
          code: 'TAG_NOT_FOUND',
          message: 'Tag tidak ditemukan',
        });
      }

      if (tag.archived) {
        throw new ConflictException({
          code: 'TAG_ARCHIVED',
          message: 'Tag sudah diarsipkan',
        });
      }

      const trimmedName = dto.name !== undefined ? dto.name.trim() : undefined;

      if (trimmedName && trimmedName.toLowerCase() !== tag.name.toLowerCase()) {
        const existing = await tx.tag.findFirst({
          where: {
            user_id: user.userId,
            financial_profile_id: tag.financial_profile_id,
            name: { equals: trimmedName, mode: 'insensitive' },
            id: { not: tagId },
          },
        });

        if (existing) {
          throw new ConflictException({
            code: 'TAG_NAME_TAKEN',
            message: 'Nama tag sudah dipakai',
          });
        }
      }

      try {
        const updated = await tx.tag.update({
          where: { id: tagId, user_id: user.userId },
          data: {
            ...(trimmedName !== undefined ? { name: trimmedName } : {}),
            ...(dto.color !== undefined ? { color: dto.color } : {}),
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'TAG_UPDATE',
            resource_type: 'tag',
            resource_id: tag.id,
            actor_user_id: user.userId,
            actor_role: user.role ?? 'USER',
            before: tag as unknown as Prisma.InputJsonValue,
            after: updated as unknown as Prisma.InputJsonValue,
          },
        });

        return updated;
      } catch (err: any) {
        if (err.code === 'P2002') {
          throw new ConflictException({
            code: 'TAG_NAME_TAKEN',
            message: 'Nama tag sudah dipakai',
          });
        }
        throw err;
      }
    });
  }

  async archive(
    user: { userId: string; role?: string },
    tagId: string,
  ): Promise<TagResponse> {
    return this.prisma.$transaction(async (tx) => {
      const tag = await tx.tag.findFirst({
        where: { id: tagId, user_id: user.userId },
      });

      if (!tag) {
        throw new NotFoundException({
          code: 'TAG_NOT_FOUND',
          message: 'Tag tidak ditemukan',
        });
      }

      if (tag.archived) {
        return tag;
      }

      const updated = await tx.tag.update({
        where: { id: tagId, user_id: user.userId },
        data: { archived: true },
      });

      await tx.auditLog.create({
        data: {
          action: 'TAG_ARCHIVE',
          resource_type: 'tag',
          resource_id: tag.id,
          actor_user_id: user.userId,
          actor_role: user.role ?? 'USER',
          before: tag as unknown as Prisma.InputJsonValue,
          after: updated as unknown as Prisma.InputJsonValue,
        },
      });

      return updated;
    });
  }
}
