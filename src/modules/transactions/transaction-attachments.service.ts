import { createHmac, randomUUID } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ALLOWED_ATTACHMENT_MIMES,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_TRANSACTION,
  type PresignAttachmentDto,
  type ConfirmAttachmentDto,
} from './dto/transaction.dto.js';

export const SIGNED_URL_TTL_SECONDS = 3600;

export function detectMimeFromMagicBytes(
  buf: Buffer,
): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (!Buffer.isBuffer(buf) || buf.length < 3) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: byte 0..3 = 52 49 46 46 ("RIFF") and byte 8..11 = 57 45 42 50 ("WEBP")
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

@Injectable()
export class TransactionAttachmentsService {
  constructor(private readonly prisma: PrismaService) {}

  // shortcut: lightweight crypto presign/signed-url adapter until full Cloudinary lifecycle in TASK-090
  private getCloudinaryConfig() {
    return {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME || 'duitku-dev',
      apiKey: process.env.CLOUDINARY_API_KEY || 'duitku-dev-key',
      apiSecret: process.env.CLOUDINARY_API_SECRET || 'duitku-dev-secret',
    };
  }

  private createHmacSignature(payload: string): string {
    const { apiSecret } = this.getCloudinaryConfig();
    return createHmac('sha256', apiSecret).update(payload).digest('hex');
  }

  private buildUploadUrl(
    storageKey: string,
    mime: string,
    size: number,
    expiresAt: Date,
  ): string {
    const { cloudName, apiKey } = this.getCloudinaryConfig();
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sigPayload = `mime=${mime}&public_id=${storageKey}&size=${size}&timestamp=${exp}&type=authenticated`;
    const signature = this.createHmacSignature(sigPayload);
    return `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload?public_id=${encodeURIComponent(storageKey)}&type=authenticated&timestamp=${exp}&api_key=${encodeURIComponent(apiKey)}&signature=${signature}`;
  }

  private buildAuthenticatedAccessUrl(
    storageKey: string,
    expiresAt: Date,
  ): string {
    const { cloudName } = this.getCloudinaryConfig();
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sigPayload = `exp=${exp}&public_id=${storageKey}&type=authenticated`;
    const signature = this.createHmacSignature(sigPayload);
    return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/image/authenticated/s--${signature.slice(0, 8)}--/v1/${storageKey}?exp=${exp}&sig=${signature}`;
  }

  private validateMimeAndSize(mime: string, size: number) {
    if (
      !ALLOWED_ATTACHMENT_MIMES.includes(
        mime as (typeof ALLOWED_ATTACHMENT_MIMES)[number],
      )
    ) {
      throw new UnprocessableEntityException({
        code: 'INVALID_FILE_TYPE',
        message: 'Tipe file harus JPEG, PNG, atau WebP',
      });
    }

    if (
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size <= 0 ||
      size > MAX_ATTACHMENT_SIZE_BYTES
    ) {
      throw new UnprocessableEntityException({
        code: 'FILE_TOO_LARGE',
        message: 'Ukuran lampiran maksimal 5 MB',
      });
    }
  }

  async presign(
    user: { userId: string; role?: string },
    transactionId: string,
    dto: PresignAttachmentDto,
  ): Promise<{
    upload_url: string;
    storage_key: string;
    expires_at: Date;
  }> {
    this.validateMimeAndSize(dto?.mime, dto?.size);

    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, user_id: user.userId },
      select: { id: true },
    });

    if (!tx) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: 'Transaksi tidak ditemukan',
      });
    }

    const currentCount = await this.prisma.fileAttachment.count({
      where: { transaction_id: transactionId },
    });

    if (currentCount >= MAX_ATTACHMENTS_PER_TRANSACTION) {
      throw new ConflictException({
        code: 'ATTACHMENT_LIMIT_EXCEEDED',
        message: 'Maksimal 3 lampiran per transaksi',
      });
    }

    const storageKey = `users/${user.userId}/tx/${transactionId}/${randomUUID()}`;
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
    const uploadUrl = this.buildUploadUrl(
      storageKey,
      dto.mime,
      dto.size,
      expiresAt,
    );

    return {
      upload_url: uploadUrl,
      storage_key: storageKey,
      expires_at: expiresAt,
    };
  }

  async confirm(
    user: { userId: string; role?: string },
    transactionId: string,
    dto: ConfirmAttachmentDto,
  ): Promise<{
    attachment_id: string;
    access_url: string;
    expires_at: Date;
  }> {
    this.validateMimeAndSize(dto?.mime, dto?.size_bytes);

    const txRow = await this.prisma.transaction.findFirst({
      where: { id: transactionId, user_id: user.userId },
      select: { id: true },
    });

    if (!txRow) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: 'Transaksi tidak ditemukan',
      });
    }

    const expectedPrefix = `users/${user.userId}/tx/${transactionId}/`;
    if (!dto.storage_key || !dto.storage_key.startsWith(expectedPrefix)) {
      throw new UnprocessableEntityException({
        code: 'INVALID_STORAGE_KEY',
        message: 'storage_key tidak sesuai dengan pengguna atau transaksi ini',
      });
    }

    const headerBuf = Buffer.from(dto.magic_bytes_base64 || '', 'base64');
    const detectedMime = detectMimeFromMagicBytes(headerBuf);
    if (!detectedMime || detectedMime !== dto.mime) {
      throw new UnprocessableEntityException({
        code: 'INVALID_FILE_TYPE',
        message: 'Isi file (magic bytes) tidak sesuai dengan format gambar',
      });
    }

    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);

    return await this.prisma.$transaction(async (tx) => {
      const currentCount = await tx.fileAttachment.count({
        where: { transaction_id: transactionId },
      });

      if (currentCount >= MAX_ATTACHMENTS_PER_TRANSACTION) {
        throw new ConflictException({
          code: 'ATTACHMENT_LIMIT_EXCEEDED',
          message: 'Maksimal 3 lampiran per transaksi',
        });
      }

      const attachment = await tx.fileAttachment.create({
        data: {
          transaction_id: transactionId,
          storage_key: dto.storage_key,
          mime: dto.mime,
          size_bytes: BigInt(dto.size_bytes),
          uploaded_by: user.userId,
        },
      });

      await tx.transactionAudit.create({
        data: {
          transaction_id: transactionId,
          action: 'UPDATE',
          before: Prisma.DbNull,
          after: { attachment_added: attachment.id },
          actor_user_id: user.userId,
        },
      });

      const accessUrl = this.buildAuthenticatedAccessUrl(
        attachment.storage_key,
        expiresAt,
      );

      return {
        attachment_id: attachment.id,
        access_url: accessUrl,
        expires_at: expiresAt,
      };
    });
  }

  async getSignedUrl(
    user: { userId: string; role?: string },
    transactionId: string,
    attachmentId: string,
  ): Promise<{
    access_url: string;
    expires_at: Date;
  }> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, user_id: user.userId },
      select: { id: true },
    });

    if (!tx) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: 'Transaksi tidak ditemukan',
      });
    }

    const attachment = await this.prisma.fileAttachment.findFirst({
      where: { id: attachmentId, transaction_id: transactionId },
    });

    if (!attachment) {
      throw new NotFoundException({
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Lampiran tidak ditemukan',
      });
    }

    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
    const accessUrl = this.buildAuthenticatedAccessUrl(
      attachment.storage_key,
      expiresAt,
    );

    return {
      access_url: accessUrl,
      expires_at: expiresAt,
    };
  }

  async remove(
    user: { userId: string; role?: string },
    transactionId: string,
    attachmentId: string,
  ): Promise<void> {
    const txRow = await this.prisma.transaction.findFirst({
      where: { id: transactionId, user_id: user.userId },
      select: { id: true },
    });

    if (!txRow) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: 'Transaksi tidak ditemukan',
      });
    }

    const attachment = await this.prisma.fileAttachment.findFirst({
      where: { id: attachmentId, transaction_id: transactionId },
    });

    if (!attachment) {
      throw new NotFoundException({
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'Lampiran tidak ditemukan',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.fileAttachment.delete({
        where: { id: attachment.id },
      });

      await tx.transactionAudit.create({
        data: {
          transaction_id: transactionId,
          action: 'UPDATE',
          before: {
            attachment_id: attachment.id,
            storage_key: attachment.storage_key,
          },
          after: { attachment_removed: attachment.id },
          actor_user_id: user.userId,
        },
      });
    });
  }
}
