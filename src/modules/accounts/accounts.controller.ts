import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AccountsService, AccountResponse } from './accounts.service.js';
import {
  createAccountSchema,
  type CreateAccountDto,
} from './dto/account.dto.js';

@ApiTags('accounts')
@ApiCookieAuth('__Host-duitku_session')
@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Membuat akun keuangan baru dengan saldo awal' })
  @ApiResponse({ status: 201, description: 'Akun berhasil dibuat' })
  @ApiResponse({ status: 400, description: 'Data tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 409, description: 'Nama akun sudah dipakai' })
  async create(
    @CurrentUser() user: { userId: string; role?: string },
    @Body(new ZodValidationPipe(createAccountSchema)) dto: CreateAccountDto,
  ): Promise<AccountResponse> {
    return this.accountsService.create(user, dto);
  }
}
