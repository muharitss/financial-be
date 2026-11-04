import {
  Controller,
  Post,
  Body,
  Headers,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import {
  CreateTransactionPipe,
  type CreateTransactionDto,
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
  @ApiOperation({ summary: 'Membuat transaksi baru (INCOME)' })
  @ApiResponse({ status: 201, description: 'Transaksi berhasil dibuat' })
  @ApiResponse({ status: 400, description: 'Data tidak valid atau kategori salah tipe' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Akun, kategori, atau tag tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Akun diarsipkan atau idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Kategori/tag diarsipkan atau client_tx_id hilang' })
  async create(
    @CurrentUser() user: { userId: string; role?: string },
    @Body(new CreateTransactionPipe()) dto: CreateTransactionDto,
    @Headers('idempotency-key') headerIdempotencyKey?: string,
  ): Promise<TransactionResponse> {
    return this.transactionsService.create(user, dto, headerIdempotencyKey);
  }
}
