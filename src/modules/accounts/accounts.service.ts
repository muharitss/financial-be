import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { todayInTz } from '../../common/utils/date.js';
import type { CreateAccountDto, UpdateAccountDto } from './dto/account.dto.js';

export interface AccountResponse {
  id: string;
  name: string;
  type: string;
  provider: string | null;
  note: string | null;
  opening_balance: number;
  opening_date: string;
  balance: number;
  reserved: number;
  available: number;
  allow_negative: boolean;
  archived: boolean;
  archived_at: Date | null;
  created_at: Date;
}

export function toAccountResponse(
  account: {
    id: string;
    name: string;
    type: string;
    provider: string | null;
    note: string | null;
    opening_balance: bigint;
    opening_date: Date;
    balance: bigint;
    allow_negative: boolean;
    archived: boolean;
    archived_at: Date | null;
    created_at: Date;
  },
  reserved: bigint = 0n,
): AccountResponse {
  const openingBalanceNum = Number(account.opening_balance);
  const balanceNum = Number(account.balance);
  const reservedNum = Number(reserved);
  const availableNum = Number(account.balance - reserved);
  const openingDateStr = account.opening_date.toISOString().slice(0, 10);

  return {
    id: account.id,
    name: account.name,
    type: account.type,
    provider: account.provider,
    note: account.note,
    opening_balance: openingBalanceNum,
    opening_date: openingDateStr,
    balance: balanceNum,
    reserved: reservedNum,
    available: availableNum,
    allow_negative: account.allow_negative,
    archived: account.archived,
    archived_at: account.archived_at,
    created_at: account.created_at,
  };
}

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    user: { userId: string; role?: string },
    dto: CreateAccountDto,
  ): Promise<AccountResponse> {
    const defaultProfile = await this.prisma.financialProfile.findFirst({
      where: {
        user_id: user.userId,
        is_default: true,
      },
    });

    if (!defaultProfile) {
      throw new NotFoundException({
        code: 'PROFILE_NOT_FOUND',
        message: 'Profil keuangan tidak ditemukan',
      });
    }

    const pref = await this.prisma.userPreference.findFirst({
      where: {
        user_id: user.userId,
      },
    });
    const tz = pref?.timezone ?? 'Asia/Jakarta';
    const today = todayInTz(tz);

    const openingDateStr = dto.opening_date ?? today;
    if (openingDateStr > today) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Tanggal saldo awal tidak boleh di masa depan',
        details: {
          opening_date: ['Tanggal saldo awal tidak boleh di masa depan'],
        },
      });
    }

    const openingDate = new Date(`${openingDateStr}T00:00:00.000Z`);
    const openingBalance = BigInt(dto.opening_balance);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const account = await tx.account.create({
          data: {
            user_id: user.userId,
            financial_profile_id: defaultProfile.id,
            name: dto.name,
            type: dto.type,
            provider: dto.provider,
            opening_balance: openingBalance,
            opening_date: openingDate,
            balance: openingBalance,
            note: dto.note,
          },
        });

        const response = toAccountResponse(account);

        await tx.auditLog.create({
          data: {
            action: 'ACCOUNT_CREATE',
            resource_type: 'account',
            resource_id: account.id,
            actor_user_id: user.userId,
            actor_role: user.role ?? 'USER',
            after: response as unknown as Prisma.InputJsonValue,
          },
        });

        return response;
      });
    } catch (error: any) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: 'ACCOUNT_NAME_TAKEN',
          message: 'Nama akun sudah dipakai',
        });
      }
      throw error;
    }
  }

  async update(
    user: { userId: string; role?: string },
    accountId: string,
    dto: UpdateAccountDto,
  ): Promise<AccountResponse> {
    const account = await this.getOwnedAccount(user.userId, accountId);

    if (account.archived) {
      throw new ConflictException({
        code: 'ACCOUNT_ARCHIVED',
        message: 'Akun sudah diarsipkan',
      });
    }

    const allocation = await this.prisma.savingsAllocation.groupBy({
      by: ['account_id'],
      where: {
        account_id: accountId,
        status: 'ACTIVE',
      },
      _sum: {
        amount: true,
      },
    });
    const reserved = allocation[0]?._sum.amount ?? 0n;
    const beforeResponse = toAccountResponse(account, reserved);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.account.update({
          where: {
            id: accountId,
            user_id: user.userId,
          },
          data: {
            name: dto.name,
            type: dto.type,
            provider: dto.provider,
            note: dto.note,
          },
        });

        const afterResponse = toAccountResponse(updated, reserved);

        await tx.auditLog.create({
          data: {
            action: 'ACCOUNT_UPDATE',
            resource_type: 'account',
            resource_id: account.id,
            actor_user_id: user.userId,
            actor_role: user.role ?? 'USER',
            before: beforeResponse as unknown as Prisma.InputJsonValue,
            after: afterResponse as unknown as Prisma.InputJsonValue,
          },
        });

        return afterResponse;
      });
    } catch (error: any) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: 'ACCOUNT_NAME_TAKEN',
          message: 'Nama akun sudah dipakai',
        });
      }
      throw error;
    }
  }

  async list(userId: string, includeArchived: boolean = false): Promise<AccountResponse[]> {
    const accounts = await this.prisma.account.findMany({
      where: {
        user_id: userId,
        ...(includeArchived ? {} : { archived: false }),
      },
      orderBy: { created_at: 'asc' },
    });

    if (accounts.length === 0) {
      return [];
    }

    const ids = accounts.map((acc) => acc.id);
    const allocations = await this.prisma.savingsAllocation.groupBy({
      by: ['account_id'],
      where: {
        account_id: { in: ids },
        status: 'ACTIVE',
      },
      _sum: {
        amount: true,
      },
    });

    const reservedMap = new Map<string, bigint>();
    for (const item of allocations) {
      if (item._sum.amount !== null) {
        reservedMap.set(item.account_id, item._sum.amount);
      }
    }

    return accounts.map((acc) =>
      toAccountResponse(acc, reservedMap.get(acc.id) ?? 0n),
    );
  }

  async archive(
    user: { userId: string; role?: string },
    accountId: string,
  ): Promise<AccountResponse> {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({
        where: {
          id: accountId,
          user_id: user.userId,
        },
      });

      if (!account) {
        throw new NotFoundException({
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Akun tidak ditemukan',
        });
      }

      if (account.archived) {
        return toAccountResponse(account, 0n);
      }

      const activeAllocations = await tx.savingsAllocation.count({
        where: {
          account_id: accountId,
          status: 'ACTIVE',
        },
      });

      if (activeAllocations > 0) {
        throw new ConflictException({
          code: 'ACCOUNT_HAS_ACTIVE_ALLOCATIONS',
          message: 'Lepaskan alokasi tabungan dari akun ini dulu',
        });
      }

      const scheduledTransactions = await tx.transaction.count({
        where: {
          user_id: user.userId,
          status: 'SCHEDULED',
          OR: [
            { account_id: accountId },
            { to_account_id: accountId },
          ],
        },
      });

      if (scheduledTransactions > 0) {
        throw new ConflictException({
          code: 'ACCOUNT_HAS_SCHEDULED_TRANSACTIONS',
          message: 'Batalkan transaksi terjadwal akun ini dulu',
        });
      }

      const updated = await tx.account.update({
        where: {
          id: accountId,
          user_id: user.userId,
        },
        data: {
          archived: true,
          archived_at: new Date(),
        },
      });

      const beforeResponse = toAccountResponse(account, 0n);
      const afterResponse = toAccountResponse(updated, 0n);

      await tx.auditLog.create({
        data: {
          action: 'ACCOUNT_ARCHIVE',
          resource_type: 'account',
          resource_id: account.id,
          actor_user_id: user.userId,
          actor_role: user.role ?? 'USER',
          before: beforeResponse as unknown as Prisma.InputJsonValue,
          after: afterResponse as unknown as Prisma.InputJsonValue,
        },
      });

      return afterResponse;
    });
  }

  async getOwnedAccount(userId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({
      where: {
        id: accountId,
        user_id: userId,
      },
    });

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Akun tidak ditemukan',
      });
    }

    return account;
  }
}
