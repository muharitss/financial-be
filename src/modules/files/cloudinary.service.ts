import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { createHash } from 'node:crypto';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  readonly cloudName: string;
  readonly apiKey: string;
  readonly apiSecret: string;

  constructor() {
    const isProd = process.env.NODE_ENV === 'production';
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (isProd) {
      if (!cloudName || !apiKey || !apiSecret) {
        throw new Error(
          'Missing required Cloudinary environment variables in production: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET',
        );
      }
      this.cloudName = cloudName;
      this.apiKey = apiKey;
      this.apiSecret = apiSecret;
    } else {
      this.cloudName = cloudName || 'duitku-dev';
      this.apiKey = apiKey || 'duitku-dev-key';
      this.apiSecret = apiSecret || 'duitku-dev-secret';
    }
  }

  sign(params: Record<string, any>, secretOverride?: string): string {
    const secret = secretOverride ?? this.apiSecret;
    const excluded = new Set(['file', 'api_key', 'resource_type', 'signature']);
    const sortedPairs = Object.keys(params)
      .filter(
        (key) =>
          !excluded.has(key) &&
          params[key] !== undefined &&
          params[key] !== null &&
          params[key] !== '',
      )
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');

    return createHash('sha1')
      .update(sortedPairs + secret)
      .digest('hex');
  }

  async upload(buffer: Buffer, publicId: string, mime: string): Promise<any> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.sign({
      public_id: publicId,
      timestamp,
      type: 'authenticated',
    });

    const formData = new FormData();
    formData.append('file', new Blob([buffer as any], { type: mime }), 'upload');
    formData.append('public_id', publicId);
    formData.append('type', 'authenticated');
    formData.append('timestamp', String(timestamp));
    formData.append('api_key', this.apiKey);
    formData.append('signature', signature);

    const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(this.cloudName)}/image/upload`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        this.logger.error(
          `Cloudinary upload failed: status=${res.status} response=${errText}`,
        );
        throw new BadGatewayException({
          code: 'FILE_STORAGE_UNAVAILABLE',
          message: 'Layanan penyimpanan file sedang tidak tersedia',
        });
      }

      return await res.json();
    } catch (err) {
      if (err instanceof BadGatewayException) {
        throw err;
      }
      this.logger.error('Cloudinary upload network error:', err);
      throw new BadGatewayException({
        code: 'FILE_STORAGE_UNAVAILABLE',
        message: 'Layanan penyimpanan file sedang tidak tersedia',
      });
    }
  }

  signedDownloadUrl(
    publicId: string,
    format: string,
    ttlSeconds = 3600,
  ): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const expiresAt = timestamp + ttlSeconds;
    const signature = this.sign({
      expires_at: expiresAt,
      format,
      public_id: publicId,
      timestamp,
      type: 'authenticated',
    });

    const query = new URLSearchParams({
      api_key: this.apiKey,
      expires_at: String(expiresAt),
      format,
      public_id: publicId,
      timestamp: String(timestamp),
      type: 'authenticated',
      signature,
    });

    return `https://api.cloudinary.com/v1_1/${encodeURIComponent(this.cloudName)}/image/download?${query.toString()}`;
  }

  async destroy(publicId: string): Promise<any> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.sign({
      invalidate: 'true',
      public_id: publicId,
      timestamp,
      type: 'authenticated',
    });

    const formData = new FormData();
    formData.append('public_id', publicId);
    formData.append('type', 'authenticated');
    formData.append('invalidate', 'true');
    formData.append('timestamp', String(timestamp));
    formData.append('api_key', this.apiKey);
    formData.append('signature', signature);

    const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(this.cloudName)}/image/destroy`;
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      this.logger.warn(
        `Cloudinary destroy failed: status=${res.status} response=${errText}`,
      );
      throw new Error(`Cloudinary destroy failed with status ${res.status}`);
    }

    return await res.json().catch(() => ({}));
  }
}
