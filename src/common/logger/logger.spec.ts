import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { sanitizeLogPayload } from './logger.module.js';
import { TraceMiddleware } from './trace.middleware.js';

describe('Logger & TraceMiddleware', () => {
  describe('sanitizeLogPayload', () => {
    it('menghapus field sensitif seperti amount, email, password, token', () => {
      const payload = {
        name: 'Budi',
        email: 'budi@example.com',
        amount: 50000,
        nominal: 50000,
        balance: 100000,
        password: 'secretPassword',
        token: 'secretToken',
        nested: {
          userPhone: '08123456789',
          safeField: 'safeValue',
        },
        items: [
          { amount: 1000, label: 'Coffee' },
          { label: 'Tea' },
        ],
      };

      const sanitized = sanitizeLogPayload(payload);

      expect(sanitized).toEqual({
        name: 'Budi',
        nested: {
          safeField: 'safeValue',
        },
        items: [
          { label: 'Coffee' },
          { label: 'Tea' },
        ],
      });
      expect((sanitized as any).email).toBeUndefined();
      expect((sanitized as any).amount).toBeUndefined();
      expect((sanitized as any).password).toBeUndefined();
      expect((sanitized as any).token).toBeUndefined();
    });

    it('mengembalikan nilai primitif tanpa perubahan', () => {
      expect(sanitizeLogPayload(null)).toBeNull();
      expect(sanitizeLogPayload(undefined)).toBeUndefined();
      expect(sanitizeLogPayload('hello')).toBe('hello');
      expect(sanitizeLogPayload(123)).toBe(123);
    });
  });

  describe('TraceMiddleware', () => {
    let middleware: TraceMiddleware;

    beforeEach(() => {
      middleware = new TraceMiddleware();
    });

    it('menggunakan X-Request-Id yang sudah ada pada request', () => {
      const req: any = { headers: { 'x-request-id': 'custom-trace-id-123' } };
      const setHeader = jest.fn();
      const res: any = { setHeader };
      const next = jest.fn();

      middleware.use(req, res, next as any);

      expect(req.id).toBe('custom-trace-id-123');
      expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'custom-trace-id-123');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('membuat UUID baru jika request tidak memiliki X-Request-Id', () => {
      const req: any = { headers: {} };
      const setHeader = jest.fn();
      const res: any = { setHeader };
      const next = jest.fn();

      middleware.use(req, res, next as any);

      expect(req.id).toBeDefined();
      expect(typeof req.id).toBe('string');
      expect(req.id.length).toBeGreaterThan(10);
      expect(setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
