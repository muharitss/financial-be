import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  type CreateCategoryDto,
  type UpdateCategoryDto,
  type CategoryResponse,
} from './dto/category.dto.js';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, includeArchived = false): Promise<CategoryResponse[]> {
    return this.prisma.category.findMany({
      where: {
        user_id: userId,
        ...(includeArchived ? {} : { archived: false }),
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  async create(
    user: { userId: string; role?: string },
    dto: CreateCategoryDto,
  ): Promise<CategoryResponse> {
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

      const parentId = dto.parent_id ?? null;

      if (parentId) {
        const parent = await tx.category.findFirst({
          where: {
            id: parentId,
            user_id: user.userId,
            financial_profile_id: profile.id,
          },
        });

        if (!parent) {
          throw new NotFoundException({
            code: 'PARENT_CATEGORY_NOT_FOUND',
            message: 'Kategori induk tidak ditemukan',
          });
        }

        if (parent.archived) {
          throw new ConflictException({
            code: 'CATEGORY_ARCHIVED',
            message: 'Kategori induk sudah diarsipkan',
          });
        }

        // Aturan domain: hierarki kategori hanya 1 tingkat subkategori
        if (parent.parent_id !== null) {
          throw new UnprocessableEntityException({
            code: 'SUBCATEGORY_DEPTH_EXCEEDED',
            message: 'Subkategori hanya diperbolehkan satu tingkat',
          });
        }

        if (parent.type !== dto.type) {
          throw new UnprocessableEntityException({
            code: 'CATEGORY_TYPE_MISMATCH',
            message: 'Jenis subkategori harus sama dengan kategori induk',
          });
        }
      }

      const trimmedName = dto.name.trim();

      const existing = await tx.category.findFirst({
        where: {
          user_id: user.userId,
          financial_profile_id: profile.id,
          parent_id: parentId,
          name: { equals: trimmedName, mode: 'insensitive' },
        },
      });

      if (existing) {
        throw new ConflictException({
          code: 'CATEGORY_NAME_TAKEN',
          message: existing.archived
            ? 'Nama kategori sudah ada di arsip. Pulihkan kategori tersebut atau gunakan nama lain.'
            : 'Nama kategori sudah dipakai',
        });
      }

      try {
        const category = await tx.category.create({
          data: {
            user_id: user.userId,
            financial_profile_id: profile.id,
            type: dto.type,
            parent_id: parentId,
            name: trimmedName,
            is_system: false,
            archived: false,
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'CATEGORY_CREATE',
            resource_type: 'category',
            resource_id: category.id,
            actor_user_id: user.userId,
            actor_role: user.role ?? 'USER',
            after: category as unknown as Prisma.InputJsonValue,
          },
        });

        return category;
      } catch (err: any) {
        if (err?.code === 'P2002') {
          throw new ConflictException({
            code: 'CATEGORY_NAME_TAKEN',
            message: 'Nama kategori sudah dipakai',
          });
        }
        throw err;
      }
    });
  }

  async update(
    user: { userId: string; role?: string },
    categoryId: string,
    dto: UpdateCategoryDto,
  ): Promise<CategoryResponse> {
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findFirst({
        where: { id: categoryId, user_id: user.userId },
      });

      if (!category) {
        throw new NotFoundException({
          code: 'CATEGORY_NOT_FOUND',
          message: 'Kategori tidak ditemukan',
        });
      }

      if (category.archived) {
        throw new ConflictException({
          code: 'CATEGORY_ARCHIVED',
          message: 'Kategori sudah diarsipkan',
        });
      }

      const trimmedName = dto.name.trim();

      if (trimmedName.toLowerCase() !== category.name.toLowerCase()) {
        const existing = await tx.category.findFirst({
          where: {
            user_id: user.userId,
            financial_profile_id: category.financial_profile_id,
            parent_id: category.parent_id,
            name: { equals: trimmedName, mode: 'insensitive' },
            id: { not: categoryId },
          },
        });

        if (existing) {
          throw new ConflictException({
            code: 'CATEGORY_NAME_TAKEN',
            message: 'Nama kategori sudah dipakai',
          });
        }
      }

      try {
        const updated = await tx.category.update({
          where: { id: categoryId, user_id: user.userId },
          data: { name: trimmedName },
        });

        await tx.auditLog.create({
          data: {
            action: 'CATEGORY_UPDATE',
            resource_type: 'category',
            resource_id: category.id,
            actor_user_id: user.userId,
            actor_role: user.role ?? 'USER',
            before: category as unknown as Prisma.InputJsonValue,
            after: updated as unknown as Prisma.InputJsonValue,
          },
        });

        return updated;
      } catch (err: any) {
        if (err?.code === 'P2002') {
          throw new ConflictException({
            code: 'CATEGORY_NAME_TAKEN',
            message: 'Nama kategori sudah dipakai',
          });
        }
        throw err;
      }
    });
  }

  async archive(
    user: { userId: string; role?: string },
    categoryId: string,
  ): Promise<CategoryResponse> {
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findFirst({
        where: { id: categoryId, user_id: user.userId },
      });

      if (!category) {
        throw new NotFoundException({
          code: 'CATEGORY_NOT_FOUND',
          message: 'Kategori tidak ditemukan',
        });
      }

      if (category.is_system) {
        throw new ConflictException({
          code: 'SYSTEM_CATEGORY_PROTECTED',
          message: 'Kategori sistem tidak dapat diarsipkan',
        });
      }

      if (category.archived) {
        return category;
      }

      const now = new Date();
      const updated = await tx.category.update({
        where: { id: categoryId, user_id: user.userId },
        data: { archived: true, archived_at: now },
      });

      // Arsipkan subkategori aktif di bawahnya agar tidak tersisa subkategori yatim
      if (category.parent_id === null) {
        await tx.category.updateMany({
          where: {
            user_id: user.userId,
            parent_id: categoryId,
            archived: false,
          },
          data: { archived: true, archived_at: now },
        });
      }

      await tx.auditLog.create({
        data: {
          action: 'CATEGORY_ARCHIVE',
          resource_type: 'category',
          resource_id: category.id,
          actor_user_id: user.userId,
          actor_role: user.role ?? 'USER',
          before: category as unknown as Prisma.InputJsonValue,
          after: updated as unknown as Prisma.InputJsonValue,
        },
      });

      return updated;
    });
  }

  async unarchive(
    user: { userId: string; role?: string },
    categoryId: string,
  ): Promise<CategoryResponse> {
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findFirst({
        where: { id: categoryId, user_id: user.userId },
      });

      if (!category) {
        throw new NotFoundException({
          code: 'CATEGORY_NOT_FOUND',
          message: 'Kategori tidak ditemukan',
        });
      }

      if (!category.archived) {
        return category;
      }

      if (category.parent_id) {
        const parent = await tx.category.findFirst({
          where: { id: category.parent_id, user_id: user.userId },
        });

        if (parent?.archived) {
          throw new ConflictException({
            code: 'PARENT_CATEGORY_ARCHIVED',
            message: 'Pulihkan kategori induk terlebih dahulu',
          });
        }
      }

      const updated = await tx.category.update({
        where: { id: categoryId, user_id: user.userId },
        data: { archived: false, archived_at: null },
      });

      await tx.auditLog.create({
        data: {
          action: 'CATEGORY_UNARCHIVE',
          resource_type: 'category',
          resource_id: category.id,
          actor_user_id: user.userId,
          actor_role: user.role ?? 'USER',
          before: category as unknown as Prisma.InputJsonValue,
          after: updated as unknown as Prisma.InputJsonValue,
        },
      });

      return updated;
    });
  }
}
