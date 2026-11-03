import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CsrfOriginGuard } from './csrf-origin.guard.js';

describe('CsrfOriginGuard', () => {
  let guard: CsrfOriginGuard;
  const originalEnv = process.env;

  beforeEach(() => {
    guard = new CsrfOriginGuard();
    process.env = { ...originalEnv };
    delete process.env.CORS_ORIGIN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createMockContext(method: string, headers: Record<string, string | undefined>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          headers,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('mengizinkan method non-mutasi (GET, HEAD, OPTIONS) tanpa validasi origin', () => {
    const context = createMockContext('GET', { origin: 'http://evil.com' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('mengizinkan method mutasi jika Origin cocok dengan default (http://localhost:3000)', () => {
    const context = createMockContext('POST', { origin: 'http://localhost:3000' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('menolak method mutasi jika Origin tidak cocok', () => {
    const context = createMockContext('POST', { origin: 'http://attacker.com' });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.getResponse()).toEqual({
        code: 'CSRF_ORIGIN_MISMATCH',
        message: 'Origin permintaan tidak diizinkan',
      });
    }
  });

  it('mengizinkan jika Origin kosong tetapi Referer cocok', () => {
    const context = createMockContext('POST', { referer: 'http://localhost:3000/dashboard' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('menolak jika Referer tidak cocok saat Origin kosong', () => {
    const context = createMockContext('PUT', { referer: 'http://malicious.org/page' });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('mengizinkan mutasi tanpa Origin/Referer saat non-production (dev/test)', () => {
    process.env.NODE_ENV = 'development';
    const context = createMockContext('POST', {});
    expect(guard.canActivate(context)).toBe(true);
  });

  it('menolak mutasi tanpa Origin/Referer saat production', () => {
    process.env.NODE_ENV = 'production';
    const context = createMockContext('POST', {});
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    try {
      guard.canActivate(context);
    } catch (err: any) {
      expect(err.getResponse()).toEqual({
        code: 'CSRF_ORIGIN_MISMATCH',
        message: 'Header Origin atau Referer wajib diisi pada lingkungan produksi',
      });
    }
  });

  it('menghormati custom CORS_ORIGIN dari environment variable', () => {
    process.env.CORS_ORIGIN = 'https://duitku.app, https://admin.duitku.app';
    const context1 = createMockContext('POST', { origin: 'https://duitku.app' });
    const context2 = createMockContext('POST', { origin: 'https://admin.duitku.app' });
    const context3 = createMockContext('POST', { origin: 'http://localhost:3000' });

    expect(guard.canActivate(context1)).toBe(true);
    expect(guard.canActivate(context2)).toBe(true);
    expect(() => guard.canActivate(context3)).toThrow(ForbiddenException);
  });
});
