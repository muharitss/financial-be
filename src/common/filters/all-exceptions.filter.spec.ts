import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  function createMockHost(reqOverrides: any = {}) {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const getHeader = jest.fn().mockReturnValue(null);
    const setHeader = jest.fn();

    const res: any = { status, json, getHeader, setHeader };
    const req: any = {
      method: 'GET',
      url: '/test',
      headers: {},
      id: 'mock-trace-123',
      ...reqOverrides,
    };

    const host: any = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    };

    return { host, req, res, status, json, setHeader };
  }

  it('mengembalikan envelope standar untuk BadRequestException dengan code VALIDATION_ERROR', () => {
    const { host, status, json, setHeader } = createMockHost();
    const exception = new BadRequestException({
      message: ['email harus valid'],
      error: 'Bad Request',
    });

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'mock-trace-123');
    expect(json).toHaveBeenCalledWith({
      code: 'VALIDATION_ERROR',
      message: 'Validasi gagal',
      details: ['email harus valid'],
      traceId: 'mock-trace-123',
    });
  });

  it('mengembalikan code RATE_LIMIT_EXCEEDED untuk error 429 Too Many Requests', () => {
    const { host, status, json } = createMockHost();
    const exception = new HttpException('ThrottlerException: Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'RATE_LIMIT_EXCEEDED',
        traceId: 'mock-trace-123',
      }),
    );
  });

  it('mempertahankan kode domain spesifik jika disediakan dalam HttpException', () => {
    const { host, status, json } = createMockHost();
    const exception = new HttpException(
      {
        code: 'INSUFFICIENT_BALANCE',
        message: 'Saldo tidak mencukupi',
        details: { needed: 50000, available: 10000 },
      },
      HttpStatus.CONFLICT,
    );

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith({
      code: 'INSUFFICIENT_BALANCE',
      message: 'Saldo tidak mencukupi',
      details: { needed: 50000, available: 10000 },
      traceId: 'mock-trace-123',
    });
  });

  it('tidak membocorkan stack trace pada production saat terjadi unhandled error', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const { host, status, json } = createMockHost();
      const exception = new Error('Secret DB connection failed at /var/app/internal');

      filter.catch(exception, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json).toHaveBeenCalledWith({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Terjadi kesalahan pada server',
        details: null,
        traceId: 'mock-trace-123',
      });
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });
});
