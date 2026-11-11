import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, SavingsGoalStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { todayInTz } from '../../common/utils/date.js';
import type { CreateSavingsGoalDto, UpdateSavingsGoalDto } from './dto/savings.dto.js';

export interface SavingsGoalResponse {
  id: string;
  name: string;
  target_amount: number;
  current_amount: number;
  remaining_amount: number;
  progress_percent: number;
  target_date: string | null;
  note: string | null;
  status: SavingsGoalStatus;
  achieved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toSavingsGoalResponse(
  goal: {
    id: string;
    name: string;
    target_amount: bigint | number;
    target_date: Date | string | null;
    note: string | null;
    status: SavingsGoalStatus;
    achieved_at: Date | null;
    created_at: Date;
    updated_at: Date;
  },
  currentAmount: bigint = 0n,
): SavingsGoalResponse {
  const targetAmountBig = BigInt(goal.target_amount);
  const currentAmountBig = BigInt(currentAmount);
  const remainingBig = targetAmountBig > currentAmountBig ? targetAmountBig - currentAmountBig : 0n;
  const progressPercent =
    targetAmountBig > 0n
      ? Number((currentAmountBig * 100n) / targetAmountBig)
      : 0;

  const targetDateStr = goal.target_date
    ? goal.target_date instanceof Date
      ? goal.target_date.toISOString().slice(0, 10)
      : String(goal.target_date).slice(0, 10)
    : null;

  return {
    id: goal.id,
    name: goal.name,
    target_amount: Number(targetAmountBig),
    current_amount: Number(currentAmountBig),
    remaining_amount: Number(remainingBig),
    progress_percent: progressPercent,
    target_date: targetDateStr,
    note: goal.note ?? null,
    status: goal.status as SavingsGoalStatus,
    achieved_at: goal.achieved_at ?? null,
    created_at: goal.created_at,
    updated_at: goal.updated_at,
  };
}

@Injectable()
export class SavingsService {
  constructor(private readonly prisma: PrismaService) {}

  toSavingsGoalResponse(
    goal: Parameters<typeof toSavingsGoalResponse>[0],
    currentAmount: bigint = 0n,
  ): SavingsGoalResponse {
    return toSavingsGoalResponse(goal, currentAmount);
  }

  async getGoalActiveSumTx(tx: Prisma.TransactionClient, goalId: string): Promise<bigint> {
    const result = await tx.savingsAllocation.aggregate({
      where: {
        savings_goal_id: goalId,
        status: 'ACTIVE',
      },
      _sum: {
        amount: true,
      },
    });
    return result._sum.amount ?? 0n;
  }

  async reconcileGoalStatusTx<
    T extends {
      id: string;
      user_id: string;
      target_amount: bigint | number;
      status: SavingsGoalStatus;
      achieved_at: Date | null;
    },
  >(
    tx: Prisma.TransactionClient,
    goal: T,
    currentAmount: bigint,
    now: Date = new Date(),
  ): Promise<T> {
    if (goal.status === 'ARCHIVED') {
      return goal;
    }

    const targetAmount = BigInt(goal.target_amount);

    if (currentAmount >= targetAmount && goal.status !== 'ACHIEVED') {
      return (await tx.savingsGoal.update({
        where: {
          id: goal.id,
          user_id: goal.user_id,
        },
        data: {
          status: 'ACHIEVED',
          achieved_at: now,
        },
      })) as unknown as T;
    }

    if (currentAmount < targetAmount && goal.status === 'ACHIEVED') {
      return (await tx.savingsGoal.update({
        where: {
          id: goal.id,
          user_id: goal.user_id,
        },
        data: {
          status: 'ACTIVE',
          achieved_at: null,
        },
      })) as unknown as T;
    }

    return goal;
  }

  async getOwnedGoal(userId: string, goalId: string) {
    const goal = await this.prisma.savingsGoal.findFirst({
      where: {
        id: goalId,
        user_id: userId,
      },
    });

    if (!goal) {
      throw new NotFoundException({
        code: 'GOAL_NOT_FOUND',
        message: 'Target tabungan tidak ditemukan',
      });
    }

    return goal;
  }

  async createGoal(
    user: { userId: string; role?: string },
    dto: CreateSavingsGoalDto,
  ): Promise<SavingsGoalResponse> {
    const defaultProfile = await this.prisma.financialProfile.findFirst({
      where: {
        user_id: user.userId,
        is_default: true,
      },
    });

    if (!defaultProfile) {
      throw new NotFoundException({
        code: 'PROFILE_NOT_FOUND',
        message: 'Profil keuangan default tidak ditemukan',
      });
    }

    const pref = await this.prisma.userPreference.findFirst({
      where: {
        user_id: user.userId,
      },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const today = todayInTz(tz);

    if (dto.target_date && dto.target_date < today) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Tanggal target tabungan tidak boleh di masa lalu',
        details: {
          target_date: ['Tanggal target tabungan tidak boleh di masa lalu'],
        },
      });
    }

    const targetDate = dto.target_date ? new Date(`${dto.target_date}T00:00:00.000Z`) : null;
    const targetAmount = BigInt(dto.target_amount);

    return this.prisma.$transaction(async (tx) => {
      const goal = await tx.savingsGoal.create({
        data: {
          user_id: user.userId,
          financial_profile_id: defaultProfile.id,
          name: dto.name,
          target_amount: targetAmount,
          target_date: targetDate,
          note: dto.note ?? null,
        },
      });

      const response = this.toSavingsGoalResponse(goal, 0n);

      await tx.auditLog.create({
        data: {
          action: 'SAVINGS_GOAL_CREATE',
          resource_type: 'savings_goal',
          resource_id: goal.id,
          actor_user_id: user.userId,
          actor_role: user.role ?? 'USER',
          after: response as unknown as Prisma.InputJsonValue,
        },
      });

      return response;
    });
  }

  async updateGoal(
    user: { userId: string; role?: string },
    goalId: string,
    dto: UpdateSavingsGoalDto,
  ): Promise<SavingsGoalResponse> {
    if (dto.target_date !== undefined && dto.target_date !== null) {
      const pref = await this.prisma.userPreference.findFirst({
        where: {
          user_id: user.userId,
        },
      });
      const tz = pref?.timezone ?? 'Asia/Jakarta';
      const today = todayInTz(tz);

      if (dto.target_date < today) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Tanggal target tabungan tidak boleh di masa lalu',
          details: {
            target_date: ['Tanggal target tabungan tidak boleh di masa lalu'],
          },
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          financial_profile_id: string;
          user_id: string;
          name: string;
          target_amount: bigint;
          target_date: Date | null;
          note: string | null;
          status: SavingsGoalStatus;
          achieved_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>
      >`SELECT id, financial_profile_id, user_id, name, target_amount, target_date, note, status, achieved_at, created_at, updated_at FROM savings_goals WHERE id = ${goalId}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

      const existing = rows[0];
      if (!existing) {
        throw new NotFoundException({
          code: 'GOAL_NOT_FOUND',
          message: 'Target tabungan tidak ditemukan',
        });
      }

      if (existing.status === 'ARCHIVED') {
        throw new ConflictException({
          code: 'GOAL_ARCHIVED',
          message: 'Target tabungan sudah diarsipkan',
        });
      }

      const currentAmount = await this.getGoalActiveSumTx(tx, goalId);
      const beforeResponse = this.toSavingsGoalResponse(existing, currentAmount);

      const updateData: Prisma.SavingsGoalUpdateInput = {};
      if (dto.name !== undefined) {
        updateData.name = dto.name;
      }
      if (dto.target_amount !== undefined) {
        updateData.target_amount = BigInt(dto.target_amount);
      }
      if (dto.target_date !== undefined) {
        updateData.target_date = dto.target_date ? new Date(`${dto.target_date}T00:00:00.000Z`) : null;
      }
      if (dto.note !== undefined) {
        updateData.note = dto.note;
      }

      const updated = await tx.savingsGoal.update({
        where: {
          id: goalId,
          user_id: user.userId,
        },
        data: updateData,
      });

      const reconciled = await this.reconcileGoalStatusTx(tx, updated, currentAmount, new Date());
      const afterResponse = this.toSavingsGoalResponse(reconciled, currentAmount);

      await tx.auditLog.create({
        data: {
          action: 'SAVINGS_GOAL_UPDATE',
          resource_type: 'savings_goal',
          resource_id: goalId,
          actor_user_id: user.userId,
          actor_role: user.role ?? 'USER',
          before: beforeResponse as unknown as Prisma.InputJsonValue,
          after: afterResponse as unknown as Prisma.InputJsonValue,
        },
      });

      return afterResponse;
    });
  }

  async archiveGoal(
    user: { userId: string; role?: string },
    goalId: string,
  ): Promise<SavingsGoalResponse> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          financial_profile_id: string;
          user_id: string;
          name: string;
          target_amount: bigint;
          target_date: Date | null;
          note: string | null;
          status: SavingsGoalStatus;
          achieved_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>
      >`SELECT id, financial_profile_id, user_id, name, target_amount, target_date, note, status, achieved_at, created_at, updated_at FROM savings_goals WHERE id = ${goalId}::uuid AND user_id = ${user.userId}::uuid FOR UPDATE`;

      const existing = rows[0];
      if (!existing) {
        throw new NotFoundException({
          code: 'GOAL_NOT_FOUND',
          message: 'Target tabungan tidak ditemukan',
        });
      }

      // Idempoten jika sudah ARCHIVED
      if (existing.status === 'ARCHIVED') {
        const currentAmount = await this.getGoalActiveSumTx(tx, goalId);
        return this.toSavingsGoalResponse(existing, currentAmount);
      }

      const activeCount = await tx.savingsAllocation.count({
        where: {
          savings_goal_id: goalId,
          status: 'ACTIVE',
        },
      });

      if (activeCount > 0) {
        throw new ConflictException({
          code: 'GOAL_HAS_ACTIVE_ALLOCATIONS',
          message: 'Lepaskan seluruh alokasi aktif pada target ini sebelum mengarsipkan',
        });
      }

      const updated = await tx.savingsGoal.update({
        where: {
          id: goalId,
          user_id: user.userId,
        },
        data: {
          status: 'ARCHIVED',
        },
      });

      const beforeResponse = this.toSavingsGoalResponse(existing, 0n);
      const afterResponse = this.toSavingsGoalResponse(updated, 0n);

      await tx.auditLog.create({
        data: {
          action: 'SAVINGS_GOAL_ARCHIVE',
          resource_type: 'savings_goal',
          resource_id: goalId,
          actor_user_id: user.userId,
          actor_role: user.role ?? 'USER',
          before: beforeResponse as unknown as Prisma.InputJsonValue,
          after: afterResponse as unknown as Prisma.InputJsonValue,
        },
      });

      return afterResponse;
    });
  }
}
