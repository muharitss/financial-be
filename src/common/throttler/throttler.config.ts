import { HttpException, HttpStatus } from '@nestjs/common';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

interface CooldownEntry {
  failures: number;
  firstAttempt: number;
  lockedUntil?: number;
}

export class LoginCooldownTracker {
  private readonly attempts = new Map<string, CooldownEntry>();

  check(key: string): void {
    const record = this.attempts.get(key);
    if (!record) return;

    const now = Date.now();
    if (record.lockedUntil && now < record.lockedUntil) {
      const waitSeconds = Math.ceil((record.lockedUntil - now) / 1000);
      throw new HttpException(
        {
          code: 'LOGIN_COOLDOWN',
          message: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${waitSeconds} detik.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (now - record.firstAttempt > 15 * 60 * 1000) {
      this.attempts.delete(key);
    }
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record || now - record.firstAttempt > 15 * 60 * 1000) {
      this.attempts.set(key, { failures: 1, firstAttempt: now });
      return;
    }

    record.failures += 1;
    if (record.failures >= 5) {
      record.lockedUntil = now + 15 * 60 * 1000;
    }
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

export const loginCooldownTracker = new LoginCooldownTracker();

export const throttlerConfig: ThrottlerModuleOptions = {
  // Single global throttler so specialized limits (@Throttle) don't choke unrelated routes
  throttlers: [{ name: 'default', limit: 120, ttl: 60000 }],
  errorMessage: 'Terlalu banyak permintaan. Silakan coba beberapa saat lagi.',
  getTracker: (req: Record<string, any>) => {
    const userId = req.user?.userId ?? req.user?.id;
    if (userId && !req.url?.startsWith('/auth')) {
      return `user:${userId}`;
    }
    return req.ip || req.socket?.remoteAddress || '127.0.0.1';
  },
};
