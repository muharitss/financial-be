import { randomUUID } from 'node:crypto';
import 'multer';
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CloudinaryService } from '../files/cloudinary.service.js';
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_TRANSACTION,
} from './dto/transaction.dto.js';

export const SIGNED_URL_TTL_SECONDS = 3600;

const FORMAT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

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
  private readonly logger = new Logger(TransactionAttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async upload(
    user: { userId: string; role?: string },
    transactionId: string,
    file?: Express.Multer.File,
  ): Promise<{
    attachment_id: string;
    mime: string;
    size_bytes: number;
    access_url: string;
    expires_at: Date;
  }> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new UnprocessableEntityException({
        code: 'FILE_REQUIRED',
        message: 'File lampiran wajib diunggah',
      });
    }

    if (
      file.size > MAX_ATTACHMENT_SIZE_BYTES ||
      file.buffer.length > MAX_ATTACHMENT_SIZE_BYTES
    ) {
      throw new UnprocessableEntityException({
        code: 'FILE_TOO_LARGE',
        message: 'Ukuran lampiran maksimal 5 MB',
      });
    }

    const txRow = await this.prisma.transaction.findFirst({
      where: { id: transactionId, user_id: user.userId },
      select: { id: true, type: true },
    });

    if (!txRow) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: 'Transaksi tidak ditemukan',
      });
    }

    if (txRow.type === 'REVERSAL') {
      throw new ConflictException({
        code: 'ATTACHMENT_NOT_ALLOWED_ON_REVERSAL',
        message: 'Transaksi reversal tidak dapat menerima lampiran',
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

    const detectedMime = detectMimeFromMagicBytes(file.buffer);
    if (!detectedMime) {
      throw new UnprocessableEntityException({
        code: 'INVALID_FILE_TYPE',
        message:
          'Isi file (magic bytes) tidak sesuai dengan format gambar JPEG, PNG, atau WebP',
      });
    }

    const format = FORMAT_MAP[detectedMime] || 'jpg';
    const storageKey = `users/${user.userId}/tx/${transactionId}/${randomUUID()}`;

    await this.cloudinaryService.upload(file.buffer, storageKey, detectedMime);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const count = await tx.fileAttachment.count({
          where: { transaction_id: transactionId },
        });

        if (count >= MAX_ATTACHMENTS_PER_TRANSACTION) {
          throw new ConflictException({
            code: 'ATTACHMENT_LIMIT_EXCEEDED',
            message: 'Maksimal 3 lampiran per transaksi',
          });
        }

        const attachment = await tx.fileAttachment.create({
          data: {
            transaction_id: transactionId,
            storage_key: storageKey,
            mime: detectedMime,
            size_bytes: BigInt(file.buffer.length),
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

        const accessUrl = this.cloudinaryService.signedDownloadUrl(
          storageKey,
          format,
          SIGNED_URL_TTL_SECONDS,
        );
        const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);

        this.logger.log(`Attachment ${attachment.id} uploaded by ${user.userId}`);

        return {
          attachment_id: attachment.id,
          mime: detectedMime,
          size_bytes: Number(attachment.size_bytes),
          access_url: accessUrl,
          expires_at: expiresAt,
        };
      });
    } catch (err) {
      try {
        await this.cloudinaryService.destroy(storageKey);
      } catch (destroyErr) {
        this.logger.warn(
          `Failed to cleanup orphaned Cloudinary file ${storageKey}:`,
          destroyErr,
        );
      }
      throw err;
    }
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

    const format = FORMAT_MAP[attachment.mime] || 'jpg';
    const accessUrl = this.cloudinaryService.signedDownloadUrl(
      attachment.storage_key,
      format,
      SIGNED_URL_TTL_SECONDS,
    );
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);

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

    try {
      await this.cloudinaryService.destroy(attachment.storage_key);
    } catch (destroyErr) {
      this.logger.warn(
        `Failed to destroy Cloudinary file ${attachment.storage_key}:`,
        destroyErr,
      );
    }
  }
}
