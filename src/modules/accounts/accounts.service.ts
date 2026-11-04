import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { todayInTz } from '../../common/utils/date.js';
import type { CreateAccountDto } from './dto/account.dto.js';

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
