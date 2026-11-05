import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import {
  PresignAttachmentPipe,
  type PresignAttachmentDto,
  ConfirmAttachmentPipe,
  type ConfirmAttachmentDto,
} from './dto/transaction.dto.js';
import { TransactionAttachmentsService } from './transaction-attachments.service.js';

@ApiTags('transaction-attachments')
@ApiCookieAuth('__Host-duitku_session')
@Controller('transactions/:id/attachments')
@UseGuards(JwtAuthGuard)
@Throttle({ attachment: { limit: 20, ttl: 3600000 } })
export class TransactionAttachmentsController {
  constructor(
    private readonly attachmentsService: TransactionAttachmentsService,
  ) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Membuat presigned URL untuk upload lampiran transaksi' })
  @ApiResponse({ status: 200, description: 'Presigned URL berhasil dibuat' })
  @ApiResponse({ status: 404, description: 'Transaksi tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Batas maksimal 3 lampiran terlampaui (ATTACHMENT_LIMIT_EXCEEDED)' })
  @ApiResponse({ status: 422, description: 'Ukuran > 5 MB (FILE_TOO_LARGE) atau tipe file tidak valid (INVALID_FILE_TYPE)' })
  async presign(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new PresignAttachmentPipe()) dto: PresignAttachmentDto,
  ) {
    return this.attachmentsService.presign(user, id, dto);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Konfirmasi lampiran transaksi dan validasi magic bytes' })
  @ApiResponse({ status: 201, description: 'Lampiran berhasil dikonfirmasi dan disimpan' })
  @ApiResponse({ status: 404, description: 'Transaksi tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Batas maksimal 3 lampiran terlampaui (ATTACHMENT_LIMIT_EXCEEDED)' })
  @ApiResponse({ status: 422, description: 'Magic bytes tidak cocok (INVALID_FILE_TYPE) atau ukuran > 5 MB (FILE_TOO_LARGE)' })
  async confirm(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ConfirmAttachmentPipe()) dto: ConfirmAttachmentDto,
  ) {
    return this.attachmentsService.confirm(user, id, dto);
  }

  @Get(':aid/url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mendapatkan Signed URL lampiran yang berlaku 1 jam (3600 detik)' })
  @ApiResponse({ status: 200, description: 'Signed URL berhasil dibuat' })
  @ApiResponse({ status: 404, description: 'Transaksi atau lampiran tidak ditemukan' })
  async getSignedUrl(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ) {
    return this.attachmentsService.getSignedUrl(user, id, aid);
  }

  @Delete(':aid')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Menghapus lampiran transaksi' })
  @ApiResponse({ status: 204, description: 'Lampiran berhasil dihapus' })
  @ApiResponse({ status: 404, description: 'Transaksi atau lampiran tidak ditemukan' })
  async remove(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ): Promise<void> {
    await this.attachmentsService.remove(user, id, aid);
  }
}
