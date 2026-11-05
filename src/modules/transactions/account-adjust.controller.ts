import {
  Controller,
  Post,
  Param,
  Body,
  Headers,
  UseGuards,
  UseInterceptors,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import {
  IdempotencyInterceptor,
  Idempotent,
} from '../../common/interceptors/idempotency.interceptor.js';
import {
  AdjustToTargetPipe,
  type AdjustToTargetDto,
} from './dto/transaction.dto.js';
import { TransactionsService } from './transactions.service.js';

@ApiTags('accounts')
@ApiCookieAuth('__Host-duitku_session')
@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class AccountAdjustController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post(':id/adjust')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ transaction: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Menyesuaikan saldo akun ke saldo target' })
  @ApiResponse({ status: 201, description: 'Saldo akun berhasil disesuaikan' })
  @ApiResponse({ status: 400, description: 'Data tidak valid atau id bukan UUID' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Akun tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Akun diarsipkan atau saldo negatif tidak diizinkan' })
  @ApiResponse({ status: 422, description: 'Tidak ada perubahan saldo atau client_tx_id hilang' })
  async adjustToTarget(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new AdjustToTargetPipe()) dto: AdjustToTargetDto,
    @Headers('idempotency-key') headerIdempotencyKey?: string,
  ) {
    return this.transactionsService.adjustToTarget(
      user,
      id,
      dto,
      headerIdempotencyKey,
    );
  }
}
