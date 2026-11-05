import {
  Controller,
  Post,
  Patch,
  Param,
  Body,
  Headers,
  UseGuards,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import {
  CreateTransactionPipe,
  type CreateTransactionDto,
  UpdateTransactionPipe,
  type UpdateTransactionDto,
} from './dto/transaction.dto.js';
import {
  TransactionsService,
  type TransactionResponse,
} from './transactions.service.js';

@ApiTags('transactions')
@ApiCookieAuth('__Host-duitku_session')
@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ transaction: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Membuat transaksi baru (INCOME, EXPENSE, TRANSFER, ADJUSTMENT)' })
  @ApiResponse({ status: 201, description: 'Transaksi berhasil dibuat' })
  @ApiResponse({ status: 400, description: 'Data tidak valid atau kategori salah tipe' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Akun, kategori, atau tag tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Akun diarsipkan, saldo tidak mencukupi, atau idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Kategori/tag diarsipkan, transfer ke akun sama, atau client_tx_id hilang' })
  async create(
    @CurrentUser() user: { userId: string; role?: string },
    @Body(new CreateTransactionPipe()) dto: CreateTransactionDto,
    @Headers('idempotency-key') headerIdempotencyKey?: string,
  ): Promise<TransactionResponse> {
    return this.transactionsService.create(user, dto, headerIdempotencyKey);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @Throttle({ transaction: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Mengubah transaksi dengan audit log' })
  @ApiResponse({ status: 200, description: 'Transaksi berhasil diubah' })
  @ApiResponse({ status: 400, description: 'Data tidak valid atau kategori salah tipe' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Transaksi tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Status konflik (ALREADY_REVERSED, CANCELLED, INSUFFICIENT_BALANCE)' })
  @ApiResponse({ status: 422, description: 'Validasi bisnis gagal (ACCOUNT_CHANGE_NOT_ALLOWED, CATEGORY_ARCHIVED, dll)' })
  async update(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new UpdateTransactionPipe()) dto: UpdateTransactionDto,
    @Headers('idempotency-key') headerIdempotencyKey?: string,
  ): Promise<{ transaction: TransactionResponse; audit_id: string; warning?: string }> {
    return this.transactionsService.update(user, id, dto, headerIdempotencyKey);
  }
}
