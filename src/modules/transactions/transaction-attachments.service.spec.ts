import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { BadGatewayException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CloudinaryService } from '../files/cloudinary.service.js';
import {
  TransactionAttachmentsService,
  detectMimeFromMagicBytes,
} from './transaction-attachments.service.js';

describe('TransactionAttachmentsService (TASK-090)', () => {
  let service: TransactionAttachmentsService;
  let prisma: any;
  let cloudinary: any;

  const user = {
    userId: '11111111-1111-1111-1111-111111111111',
    role: 'USER',
  };
  const txId = '22222222-2222-2222-2222-222222222222';
  const aid = '33333333-3333-3333-3333-333333333333';

  const jpegBuffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]);

  const pngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);

  const webpBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);

  const textBuffer = Buffer.from('Hello world not an image');

  const makeMulterFile = (
    buf: Buffer,
    originalname = 'receipt.jpg',
    mimetype = 'image/jpeg',
  ): Express.Multer.File => ({
    fieldname: 'file',
    originalname,
    encoding: '7bit',
    mimetype,
    size: buf.length,
    buffer: buf,
    destination: '',
    filename: originalname,
    path: '',
    stream: null as any,
  });

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

    cloudinary = {
      sign: jest.fn(),
      upload: jest.fn<any>().mockResolvedValue({
        public_id: `users/${user.userId}/tx/${txId}/mock`,
        bytes: 100,
      }),
      signedDownloadUrl: jest.fn(
        (key: string, format: string) =>
          `https://api.cloudinary.com/v1_1/test-cloud/image/download?format=${format}&public_id=${key}&expires_at=123`,
      ),
      destroy: jest.fn<any>().mockResolvedValue({ result: 'ok' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionAttachmentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudinaryService, useValue: cloudinary },
      ],
    }).compile();

    service = module.get<TransactionAttachmentsService>(
      TransactionAttachmentsService,
    );
  });

  describe('detectMimeFromMagicBytes', () => {
    it('mendeteksi JPEG (FF D8 FF)', () => {
      expect(detectMimeFromMagicBytes(jpegBuffer)).toBe('image/jpeg');
    });

    it('mendeteksi PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
      expect(detectMimeFromMagicBytes(pngBuffer)).toBe('image/png');
    });

    it('mendeteksi WebP (RIFF....WEBP)', () => {
      expect(detectMimeFromMagicBytes(webpBuffer)).toBe('image/webp');
    });

    it('mengembalikan null untuk teks atau buffer tidak dikenal', () => {
      expect(detectMimeFromMagicBytes(textBuffer)).toBeNull();
      expect(detectMimeFromMagicBytes(Buffer.from([0x00, 0x01]))).toBeNull();
    });
  });

  describe('upload', () => {
    it('AC-2: upload JPEG valid -> 201, FileAttachment + TransactionAudit dibuat, access_url ke image/download', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({
        id: txId,
        type: 'EXPENSE',
      });
      prisma.fileAttachment.count.mockResolvedValueOnce(0);
      prisma.fileAttachment.count.mockResolvedValueOnce(0);
      prisma.fileAttachment.create.mockResolvedValueOnce({
        id: aid,
        transaction_id: txId,
        storage_key: `users/${user.userId}/tx/${txId}/file-1`,
        mime: 'image/jpeg',
        size_bytes: BigInt(jpegBuffer.length),
        uploaded_by: user.userId,
      });
      prisma.transactionAudit.create.mockResolvedValueOnce({ id: 'audit-1' });

      const file = makeMulterFile(jpegBuffer);
      const res = await service.upload(user, txId, file);

      expect(res.attachment_id).toBe(aid);
      expect(res.mime).toBe('image/jpeg');
      expect(res.size_bytes).toBe(jpegBuffer.length);
      expect(res.access_url).toContain('api.cloudinary.com/v1_1/');
      expect(res.access_url).toContain('image/download');
      expect(res.expires_at).toBeInstanceOf(Date);

      expect(cloudinary.upload).toHaveBeenCalledTimes(1);
      expect(prisma.fileAttachment.create).toHaveBeenCalled();
      expect(prisma.transactionAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          transaction_id: txId,
          action: 'UPDATE',
          after: { attachment_added: aid },
          actor_user_id: user.userId,
        }),
      });
    });

    it('AC-3: file teks yang di-rename .jpg -> 422 INVALID_FILE_TYPE dan tidak ada request ke Cloudinary', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({
        id: txId,
        type: 'EXPENSE',
      });
      prisma.fileAttachment.count.mockResolvedValueOnce(0);

      const fakeJpg = makeMulterFile(textBuffer, 'fake.jpg', 'image/jpeg');

      await expect(service.upload(user, txId, fakeJpg)).rejects.toMatchObject({
        response: { code: 'INVALID_FILE_TYPE' },
      });

      expect(cloudinary.upload).not.toHaveBeenCalled();
      expect(prisma.fileAttachment.create).not.toHaveBeenCalled();
    });

    it('AC-4: file > 5 MB -> ditolak 422 FILE_TOO_LARGE sebelum dibaca ke Cloudinary', async () => {
      const hugeBuffer = Buffer.alloc(5_242_881);
      const file = makeMulterFile(hugeBuffer);

      await expect(service.upload(user, txId, file)).rejects.toMatchObject({
        response: { code: 'FILE_TOO_LARGE' },
      });

      expect(cloudinary.upload).not.toHaveBeenCalled();
    });

    it('AC-4: upload ke-4 saat sudah ada 3 lampiran -> 409 ATTACHMENT_LIMIT_EXCEEDED tanpa panggil Cloudinary', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({
        id: txId,
        type: 'EXPENSE',
      });
      prisma.fileAttachment.count.mockResolvedValueOnce(3);

      const file = makeMulterFile(jpegBuffer);

      await expect(service.upload(user, txId, file)).rejects.toMatchObject({
        response: { code: 'ATTACHMENT_LIMIT_EXCEEDED' },
      });

      expect(cloudinary.upload).not.toHaveBeenCalled();
    });

    it('AC-5: panggil destroy(publicId) jika insert DB gagal setelah upload Cloudinary sukses', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({
        id: txId,
        type: 'EXPENSE',
      });
      prisma.fileAttachment.count.mockResolvedValueOnce(1);
      prisma.$transaction.mockRejectedValueOnce(new Error('DB connection dead'));

      const file = makeMulterFile(pngBuffer, 'receipt.png', 'image/png');

      await expect(service.upload(user, txId, file)).rejects.toThrow(
        'DB connection dead',
      );

      expect(cloudinary.upload).toHaveBeenCalledTimes(1);
      expect(cloudinary.destroy).toHaveBeenCalledTimes(1);
      const destroyedKey = cloudinary.destroy.mock.calls[0][0];
      expect(destroyedKey).toContain(`users/${user.userId}/tx/${txId}/`);
    });

    it('AC-6 (isolasi): upload pada transaksi milik user lain -> 404 TRANSACTION_NOT_FOUND', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce(null);

      const file = makeMulterFile(jpegBuffer);

      await expect(
        service.upload({ userId: 'other-user' }, txId, file),
      ).rejects.toMatchObject({
        response: { code: 'TRANSACTION_NOT_FOUND' },
      });

      expect(cloudinary.upload).not.toHaveBeenCalled();
    });

    it('AC-7: upload ke transaksi REVERSAL -> 409 ATTACHMENT_NOT_ALLOWED_ON_REVERSAL', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({
        id: txId,
        type: 'REVERSAL',
      });

      const file = makeMulterFile(jpegBuffer);

      await expect(service.upload(user, txId, file)).rejects.toMatchObject({
        response: { code: 'ATTACHMENT_NOT_ALLOWED_ON_REVERSAL' },
      });

      expect(cloudinary.upload).not.toHaveBeenCalled();
    });

    it('tolak 422 FILE_REQUIRED jika file tidak ada atau kosong', async () => {
      await expect(
        service.upload(user, txId, undefined as any),
      ).rejects.toMatchObject({
        response: { code: 'FILE_REQUIRED' },
      });

      await expect(
        service.upload(user, txId, makeMulterFile(Buffer.alloc(0))),
      ).rejects.toMatchObject({
        response: { code: 'FILE_REQUIRED' },
      });
    });

    it('meneruskan 502 FILE_STORAGE_UNAVAILABLE jika Cloudinary upload gagal', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({
        id: txId,
        type: 'EXPENSE',
      });
      prisma.fileAttachment.count.mockResolvedValueOnce(0);
      cloudinary.upload.mockRejectedValueOnce(
        new BadGatewayException({ code: 'FILE_STORAGE_UNAVAILABLE' }),
      );

      const file = makeMulterFile(jpegBuffer);

      await expect(service.upload(user, txId, file)).rejects.toMatchObject({
        response: { code: 'FILE_STORAGE_UNAVAILABLE' },
      });
    });
  });

  describe('getSignedUrl', () => {
    it('mengembalikan signed download URL 1 jam untuk lampiran', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });
      prisma.fileAttachment.findFirst.mockResolvedValueOnce({
        id: aid,
        transaction_id: txId,
        storage_key: `users/${user.userId}/tx/${txId}/pic-1`,
        mime: 'image/png',
      });

      const before = Date.now();
      const res = await service.getSignedUrl(user, txId, aid);
      const after = Date.now();

      expect(cloudinary.signedDownloadUrl).toHaveBeenCalledWith(
        `users/${user.userId}/tx/${txId}/pic-1`,
        'png',
        3600,
      );
      expect(res.access_url).toContain('api.cloudinary.com/v1_1/');
      const diffSec = (res.expires_at.getTime() - before) / 1000;
      expect(diffSec).toBeGreaterThanOrEqual(3598);
      expect((res.expires_at.getTime() - after) / 1000).toBeLessThanOrEqual(
        3602,
      );
    });

    it('AC-6 (isolasi): transaksi bukan milik user -> 404 TRANSACTION_NOT_FOUND', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.getSignedUrl({ userId: 'other-user' }, txId, aid),
      ).rejects.toMatchObject({
        response: { code: 'TRANSACTION_NOT_FOUND' },
      });
    });

    it('lampiran tidak ditemukan -> 404 ATTACHMENT_NOT_FOUND', async () => {
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
    it('AC-5: hapus FileAttachment, catat audit, dan panggil destroy di Cloudinary', async () => {
      const storageKey = `users/${user.userId}/tx/${txId}/pic-1`;
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
      expect(cloudinary.destroy).toHaveBeenCalledWith(storageKey);
    });

    it('transaksi tidak ditemukan -> 404 TRANSACTION_NOT_FOUND', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce(null);

      await expect(service.remove(user, txId, aid)).rejects.toMatchObject({
        response: { code: 'TRANSACTION_NOT_FOUND' },
      });
      expect(cloudinary.destroy).not.toHaveBeenCalled();
    });

    it('lampiran tidak ditemukan -> 404 ATTACHMENT_NOT_FOUND', async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce({ id: txId });
      prisma.fileAttachment.findFirst.mockResolvedValueOnce(null);

      await expect(service.remove(user, txId, aid)).rejects.toMatchObject({
        response: { code: 'ATTACHMENT_NOT_FOUND' },
      });
      expect(cloudinary.destroy).not.toHaveBeenCalled();
    });
  });
});
