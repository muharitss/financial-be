import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { CloudinaryService } from './cloudinary.service.js';

describe('CloudinaryService (TASK-090)', () => {
  let service: CloudinaryService;
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NODE_ENV = 'development';
    process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
    process.env.CLOUDINARY_API_KEY = 'test-key';
    process.env.CLOUDINARY_API_SECRET = 'test-secret';
    service = new CloudinaryService();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('AC-1: sign', () => {
    it('menghasilkan sha1 hex dari parameter terurut alfabet + secret', () => {
      const expected = createHash('sha1')
        .update('public_id=sample&timestamp=1315060510abcd')
        .digest('hex');

      const sig = service.sign(
        { public_id: 'sample', timestamp: 1315060510 },
        'abcd',
      );

      expect(sig).toBe(expected);
      expect(sig).toBe('c3470533147774275dd37996cc4d0e68fd03cd4f');
    });

    it('mengabaikan parameter file, api_key, resource_type, dan signature', () => {
      const sigWithoutExcluded = service.sign(
        { public_id: 'sample', timestamp: 1315060510 },
        'abcd',
      );

      const sigWithExcluded = service.sign(
        {
          public_id: 'sample',
          timestamp: 1315060510,
          file: 'some-file-data',
          api_key: 'excluded-key',
          resource_type: 'image',
          signature: 'ignore-this',
        },
        'abcd',
      );

      expect(sigWithExcluded).toBe(sigWithoutExcluded);
    });
  });

  describe('AC-2: signedDownloadUrl', () => {
    it('menghasilkan URL private download Cloudinary dengan expires_at ~3600 detik', () => {
      const before = Math.floor(Date.now() / 1000);
      const url = service.signedDownloadUrl('users/u1/tx/t1/pic', 'jpg');
      const after = Math.floor(Date.now() / 1000);

      expect(url).toContain('https://api.cloudinary.com/v1_1/test-cloud/image/download?');
      expect(url).toContain('format=jpg');
      expect(url).toContain('type=authenticated');
      expect(url).toContain('api_key=test-key');
      expect(url).toContain('signature=');

      const parsed = new URL(url);
      const expiresAt = Number(parsed.searchParams.get('expires_at'));
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3598);
      expect(expiresAt).toBeLessThanOrEqual(after + 3602);
    });
  });

  describe('upload', () => {
    it('mengunggah multipart FormData ke Cloudinary image/upload', async () => {
      const mockFetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        json: async () => ({
          public_id: 'users/u1/tx/t1/pic',
          bytes: 1234,
        }),
      });
      global.fetch = mockFetch;

      const buffer = Buffer.from('image-content');
      const result = await service.upload(
        buffer,
        'users/u1/tx/t1/pic',
        'image/jpeg',
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.cloudinary.com/v1_1/test-cloud/image/upload');
      expect(options.method).toBe('POST');
      expect(options.body).toBeInstanceOf(FormData);
      expect(result.public_id).toBe('users/u1/tx/t1/pic');
    });

    it('melempar 502 FILE_STORAGE_UNAVAILABLE jika Cloudinary merespons error', async () => {
      global.fetch = jest.fn<any>().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Cloudinary server down',
      });

      await expect(
        service.upload(Buffer.from('test'), 'pic-1', 'image/png'),
      ).rejects.toMatchObject({
        response: { code: 'FILE_STORAGE_UNAVAILABLE' },
      });
    });

    it('melempar 502 FILE_STORAGE_UNAVAILABLE jika jaringan terputus', async () => {
      global.fetch = jest.fn<any>().mockRejectedValue(new Error('Network error'));

      await expect(
        service.upload(Buffer.from('test'), 'pic-1', 'image/png'),
      ).rejects.toMatchObject({
        response: { code: 'FILE_STORAGE_UNAVAILABLE' },
      });
    });
  });

  describe('destroy', () => {
    it('mengirim request destroy ke Cloudinary image/destroy', async () => {
      const mockFetch = jest.fn<any>().mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'ok' }),
      });
      global.fetch = mockFetch;

      const res = await service.destroy('users/u1/tx/t1/pic');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.cloudinary.com/v1_1/test-cloud/image/destroy');
      expect(options.method).toBe('POST');
      expect(res.result).toBe('ok');
    });

    it('melempar error jika respons Cloudinary !ok', async () => {
      global.fetch = jest.fn<any>().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

      await expect(service.destroy('users/u1/tx/t1/pic')).rejects.toThrow(
        /Cloudinary destroy failed with status 404/,
      );
    });
  });

  describe('AC-8: Inisialisasi & validasi production', () => {
    it('gagal boot saat NODE_ENV=production tanpa CLOUDINARY_API_SECRET', () => {
      process.env.NODE_ENV = 'production';
      process.env.CLOUDINARY_CLOUD_NAME = 'prod-cloud';
      process.env.CLOUDINARY_API_KEY = 'prod-key';
      delete process.env.CLOUDINARY_API_SECRET;

      expect(() => new CloudinaryService()).toThrow(
        /Missing required Cloudinary environment variables in production/,
      );
    });

    it('gagal boot saat NODE_ENV=production tanpa CLOUDINARY_CLOUD_NAME atau API_KEY', () => {
      process.env.NODE_ENV = 'production';
      process.env.CLOUDINARY_API_SECRET = 'secret';
      delete process.env.CLOUDINARY_CLOUD_NAME;

      expect(() => new CloudinaryService()).toThrow(
        /Missing required Cloudinary environment variables in production/,
      );
    });

    it('berhasil instansiasi saat development tanpa env dengan nilai default', () => {
      delete process.env.CLOUDINARY_CLOUD_NAME;
      delete process.env.CLOUDINARY_API_KEY;
      delete process.env.CLOUDINARY_API_SECRET;
      process.env.NODE_ENV = 'development';

      const devService = new CloudinaryService();
      expect(devService.cloudName).toBe('duitku-dev');
      expect(devService.apiKey).toBe('duitku-dev-key');
      expect(devService.apiSecret).toBe('duitku-dev-secret');
    });
  });
});
