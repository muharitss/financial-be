import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  TransactionAttachmentsService,
  detectMimeFromMagicBytes,
} from './transaction-attachments.service.js';

describe('TransactionAttachmentsService (TASK-049)', () => {
  let service: TransactionAttachmentsService;
  let prisma: any;

  const user = {
    userId: '11111111-1111-1111-1111-111111111111',
    role: 'USER',
  };
  const txId = '22222222-2222-2222-2222-222222222222';
  const aid = '33333333-3333-3333-3333-333333333333';

  const jpegMagicBase64 = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]).toString('base64');

  const pngMagicBase64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]).toString('base64');

  const webpMagicBase64 = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]).toString('base64');

  const textMagicBase64 = Buffer.from('Hello world not an image').toString(
    'base64',
  );

  beforeEach(async () => {
    prisma = {
      transaction: {
        findFirst: jest.fn<any>(),
      },
      fileAttachment: {
        count: jest.fn<any>(),
        create: jest.fn<any>(),
        findFirst: jest.fn<any>(),
        delete: jest.fn<any>(),
      },
      transactionAudit: {
        create: jest.fn<any>(),
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionAttachmentsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<TransactionAttachmentsService>(
      TransactionAttachmentsService,
    );
  });

  describe('detectMimeFromMagicBytes', () => {
    it('mendeteksi JPEG (FF D8 FF)', () => {
      const buf = Buffer.from(jpegMagicBase64, 'base64');
      expect(detectMimeFromMagicBytes(buf)).toBe('image/jpeg');
    });

    it('mendeteksi PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
      const buf = Buffer.from(pngMagicBase64, 'base64');
      expect(detectMimeFromMagicBytes(buf)).toBe('image/png');
    });

    it('mendeteksi WebP (RIFF....WEBP)', () => {
      const buf = Buffer.from(webpMagicBase64, 'base64');
      expect(detectMimeFromMagicBytes(buf)).toBe('image/webp');
    });

    it('mengembalikan null untuk teks atau buffer tidak dikenal', () => {
      const buf = Buffer.from(textMagicBase64, 'base64');
      expect(detectMimeFromMagicBytes(buf)).toBeNull();
      expect(detectMimeFromMagicBytes(Buffer.from([0x00, 0x01]))).toBeNull();
    });
  });

  describe('presign', () => {
    it('AC-1: presign { mime: image/jpeg, size: 3000000 } -> 200 { upload_url, storage_key, expires_at }', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });
      prisma.fileAttachment.count.mockResolvedValueOnce(0);

      const res = await service.presign(user, txId, {
        mime: 'image/jpeg',
        size: 3_000_000,
      });

      expect(res.upload_url).toContain('https://api.cloudinary.com/v1_1/');
      expect(res.storage_key).toMatch(
        new RegExp(`^users/${user.userId}/tx/${txId}/`),
      );
      expect(res.expires_at).toBeInstanceOf(Date);
    });

    it('AC-2: presign dengan size: 6000000 (> 5 MB) -> 422 FILE_TOO_LARGE', async () => {
      await expect(
        service.presign(user, txId, {
          mime: 'image/jpeg',
          size: 6_000_000,
        }),
      ).rejects.toMatchObject({
        response: { code: 'FILE_TOO_LARGE' },
      });
    });

    it('presign dengan tipe MIME tidak diizinkan -> 422 INVALID_FILE_TYPE', async () => {
      await expect(
        service.presign(user, txId, {
          mime: 'application/pdf' as any,
          size: 100_000,
        }),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_FILE_TYPE' },
      });
    });

    it('AC-4: presign ke-4 saat sudah ada 3 lampiran -> 409 ATTACHMENT_LIMIT_EXCEEDED', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });
      prisma.fileAttachment.count.mockResolvedValueOnce(3);

      await expect(
        service.presign(user, txId, {
          mime: 'image/png',
          size: 500_000,
        }),
      ).rejects.toMatchObject({
        response: { code: 'ATTACHMENT_LIMIT_EXCEEDED' },
      });
    });

    it('AC-6 (isolasi): presign pada transaksi user lain -> 404 TRANSACTION_NOT_FOUND', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.presign({ userId: 'other-user' }, txId, {
          mime: 'image/jpeg',
          size: 500_000,
        }),
      ).rejects.toMatchObject({
        response: { code: 'TRANSACTION_NOT_FOUND' },
      });
    });
  });

  describe('confirm', () => {
    const validStorageKey = `users/${user.userId}/tx/${txId}/file-uuid-1`;

    it('AC-3: confirm dengan mime image/jpeg tetapi magic_bytes_base64 berisi PNG/teks -> 422 INVALID_FILE_TYPE', async () => {
      prisma.transaction.findFirst.mockResolvedValue({ id: txId });

      await expect(
        service.confirm(user, txId, {
          storage_key: validStorageKey,
          mime: 'image/jpeg',
          size_bytes: 1_000_000,
          magic_bytes_base64: pngMagicBase64,
        }),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_FILE_TYPE' },
      });

      await expect(
        service.confirm(user, txId, {
          storage_key: validStorageKey,
          mime: 'image/jpeg',
          size_bytes: 1_000_000,
          magic_bytes_base64: textMagicBase64,
        }),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_FILE_TYPE' },
      });

      expect(prisma.fileAttachment.create).not.toHaveBeenCalled();
    });

    it('AC-4: confirm dengan magic bytes JPEG/PNG/WebP valid -> 201 { attachment_id, access_url, expires_at } + audit', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });
      prisma.fileAttachment.count.mockResolvedValueOnce(2);
      prisma.fileAttachment.create.mockResolvedValueOnce({
        id: aid,
        transaction_id: txId,
        storage_key: validStorageKey,
        mime: 'image/webp',
        size_bytes: 250000n,
        uploaded_by: user.userId,
        uploaded_at: new Date(),
      });
      prisma.transactionAudit.create.mockResolvedValueOnce({ id: 'audit-1' });

      const res = await service.confirm(user, txId, {
        storage_key: validStorageKey,
        mime: 'image/webp',
        size_bytes: 250_000,
        magic_bytes_base64: webpMagicBase64,
      });

      expect(res.attachment_id).toBe(aid);
      expect(res.access_url).toContain('image/authenticated/');
      expect(res.expires_at).toBeInstanceOf(Date);
      expect(prisma.transactionAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          transaction_id: txId,
          action: 'UPDATE',
          after: { attachment_added: aid },
          actor_user_id: user.userId,
        }),
      });
    });

    it('AC-4: confirm ke-4 saat sudah ada 3 lampiran -> 409 ATTACHMENT_LIMIT_EXCEEDED', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });
      prisma.fileAttachment.count.mockResolvedValueOnce(3);

      await expect(
        service.confirm(user, txId, {
          storage_key: validStorageKey,
          mime: 'image/jpeg',
          size_bytes: 200_000,
          magic_bytes_base64: jpegMagicBase64,
        }),
      ).rejects.toMatchObject({
        response: { code: 'ATTACHMENT_LIMIT_EXCEEDED' },
      });
    });

    it('tolak 422 INVALID_STORAGE_KEY jika prefix storage_key bukan milik user/transaksi', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });

      await expect(
        service.confirm(user, txId, {
          storage_key: 'users/other-user/tx/other-tx/file-1',
          mime: 'image/jpeg',
          size_bytes: 200_000,
          magic_bytes_base64: jpegMagicBase64,
        }),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_STORAGE_KEY' },
      });
    });
  });

  describe('getSignedUrl', () => {
    it('AC-5: mengembalikan signed URL dengan expires_at sekitar +3600 detik (1 jam)', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });
      prisma.fileAttachment.findFirst.mockResolvedValueOnce({
        id: aid,
        transaction_id: txId,
        storage_key: `users/${user.userId}/tx/${txId}/file-1`,
        mime: 'image/jpeg',
        size_bytes: 100000n,
      });

      const before = Date.now();
      const res = await service.getSignedUrl(user, txId, aid);
      const after = Date.now();

      expect(res.access_url).toContain('exp=');
      expect(res.access_url).toContain('sig=');
      const diffSeconds = (res.expires_at.getTime() - before) / 1000;
      expect(diffSeconds).toBeGreaterThanOrEqual(3598);
      expect((res.expires_at.getTime() - after) / 1000).toBeLessThanOrEqual(
        3602,
      );
    });

    it('melempar 404 ATTACHMENT_NOT_FOUND jika lampiran tidak ada', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });
      prisma.fileAttachment.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.getSignedUrl(user, txId, aid),
      ).rejects.toMatchObject({
        response: { code: 'ATTACHMENT_NOT_FOUND' },
      });
    });
  });

  describe('remove', () => {
    it('menghapus FileAttachment dan mencatat TransactionAudit', async () => {
      const storageKey = `users/${user.userId}/tx/${txId}/file-1`;
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });
      prisma.fileAttachment.findFirst.mockResolvedValueOnce({
        id: aid,
        transaction_id: txId,
        storage_key: storageKey,
      });
      prisma.fileAttachment.delete.mockResolvedValueOnce({ id: aid });
      prisma.transactionAudit.create.mockResolvedValueOnce({ id: 'audit-del' });

      await service.remove(user, txId, aid);

      expect(prisma.fileAttachment.delete).toHaveBeenCalledWith({
        where: { id: aid },
      });
      expect(prisma.transactionAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          transaction_id: txId,
          action: 'UPDATE',
          after: { attachment_removed: aid },
          actor_user_id: user.userId,
        }),
      });
    });
  });
});
