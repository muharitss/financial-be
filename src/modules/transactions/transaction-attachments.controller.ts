import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiCookieAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { MAX_ATTACHMENT_SIZE_BYTES } from './dto/transaction.dto.js';
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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES, files: 1 },
    }),
  )
  @ApiOperation({ summary: 'Upload lampiran transaksi (multipart/form-data)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Lampiran berhasil diunggah' })
  @ApiResponse({ status: 404, description: 'Transaksi tidak ditemukan' })
  @ApiResponse({
    status: 409,
    description:
      'Batas maksimal 3 lampiran terlampaui (ATTACHMENT_LIMIT_EXCEEDED) atau reversal (ATTACHMENT_NOT_ALLOWED_ON_REVERSAL)',
  })
  @ApiResponse({
    status: 422,
    description:
      'File wajib (FILE_REQUIRED), magic bytes tidak cocok (INVALID_FILE_TYPE), atau ukuran > 5 MB (FILE_TOO_LARGE)',
  })
  @ApiResponse({
    status: 502,
    description: 'Penyimpanan file sedang tidak tersedia (FILE_STORAGE_UNAVAILABLE)',
  })
  async upload(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.attachmentsService.upload(user, id, file);
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
