import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  UnprocessableEntityException,
  ConflictException,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';
import { Prisma } from '@prisma/client';
import {
  IdempotencyInterceptor,
  computeRequestHash,
  canonicalJson,
  removeClientTxId,
} from './idempotency.interceptor.js';

describe('IdempotencyInterceptor (TASK-052)', () => {
  let interceptor: IdempotencyInterceptor;
  let prismaMock: any;
  let reflectorMock: any;

  const validUlid1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const validUlid2 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
  const userId = 'a0000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    prismaMock = {
      idempotencyKey: {
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
    };
    reflectorMock = {
      getAllAndOverride: jest.fn().mockReturnValue({ requireUlid: true }),
    };

    interceptor = new IdempotencyInterceptor(prismaMock, reflectorMock);
  });

  describe('canonicalJson & computeRequestHash', () => {
    it('menghasilkan JSON kanonikal dengan kunci terurut secara alfabetis', () => {
      const obj1 = { b: 2, a: 1, c: { y: 20, x: 10 } };
      const obj2 = { a: 1, c: { x: 10, y: 20 }, b: 2 };
      expect(canonicalJson(obj1)).toBe('{"a":1,"b":2,"c":{"x":10,"y":20}}');
      expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
    });

    it('removeClientTxId menghapus client_tx_id dari root objek', () => {
      const body = { amount: 50000, client_tx_id: validUlid1, type: 'EXPENSE' };
      expect(removeClientTxId(body)).toEqual({ amount: 50000, type: 'EXPENSE' });
    });

    it('computeRequestHash menghasilkan hash identik jika client_tx_id ada di body vs header', () => {
      const bodyWithTx = { amount: 50000, client_tx_id: validUlid1, type: 'EXPENSE' };
      const bodyWithoutTx = { type: 'EXPENSE', amount: 50000 };

      const hash1 = computeRequestHash('POST', '/transactions', bodyWithTx);
      const hash2 = computeRequestHash('POST', '/transactions', bodyWithoutTx);
      expect(hash1).toBe(hash2);
    });

    it('computeRequestHash menghasilkan hash berbeda jika nominal atau path berubah', () => {
      const hash1 = computeRequestHash('POST', '/transactions', { amount: 50000 });
      const hash2 = computeRequestHash('POST', '/transactions', { amount: 60000 });
      const hash3 = computeRequestHash('PATCH', '/transactions/123', { amount: 50000 });

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });
  });

  describe('interceptor behavior', () => {
    function createMockContext(req: any, res: any = {}): ExecutionContext {
      res.statusCode = res.statusCode || 201;
      res.status = jest.fn((code: number) => {
        res.statusCode = code;
        return res;
      });
      return {
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => res,
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext;
    }

    function createMockCallHandler(returnValue: any): CallHandler {
      return {
        handle: () => of(returnValue),
      };
    }

    it('lewat tanpa cek jika endpoint tidak memiliki decorator @Idempotent', async () => {
      reflectorMock.getAllAndOverride.mockReturnValue(undefined);
      const req = { user: { userId } };
      const context = createMockContext(req);
      const callHandler = createMockCallHandler({ success: true });

      const stream$ = await interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(stream$);

      expect(result).toEqual({ success: true });
      expect(prismaMock.idempotencyKey.findUnique).not.toHaveBeenCalled();
    });

    it('lewat tanpa simpan jika user tidak terautentikasi', async () => {
      const req = { user: null };
      const context = createMockContext(req);
      const callHandler = createMockCallHandler({ success: true });

      const stream$ = await interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(stream$);

      expect(result).toEqual({ success: true });
      expect(prismaMock.idempotencyKey.findUnique).not.toHaveBeenCalled();
    });

    it('AC-3: melempar 422 MISSING_CLIENT_TX_ID jika client_tx_id dan header tidak disertakan', async () => {
      const req = {
        user: { userId },
        body: { amount: 10000 },
        headers: {},
      };
      const context = createMockContext(req);
      const callHandler = createMockCallHandler({});

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        UnprocessableEntityException,
      );
      try {
        await interceptor.intercept(context, callHandler);
      } catch (err: any) {
        expect(err.getResponse().code).toBe('MISSING_CLIENT_TX_ID');
      }
    });

    it('melempar 422 VALIDATION_ERROR jika body client_tx_id dan header Idempotency-Key bernilai berbeda', async () => {
      const req = {
        user: { userId },
        body: { amount: 10000, client_tx_id: validUlid1 },
        headers: { 'idempotency-key': validUlid2 },
      };
      const context = createMockContext(req);
      const callHandler = createMockCallHandler({});

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        UnprocessableEntityException,
      );
      try {
        await interceptor.intercept(context, callHandler);
      } catch (err: any) {
        expect(err.getResponse().code).toBe('VALIDATION_ERROR');
      }
    });

    it('melempar 422 VALIDATION_ERROR jika format bukan ULID valid', async () => {
      const req = {
        user: { userId },
        body: { amount: 10000, client_tx_id: 'bukan-ulid-valid' },
        headers: {},
      };
      const context = createMockContext(req);
      const callHandler = createMockCallHandler({});

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        UnprocessableEntityException,
      );
      try {
        await interceptor.intercept(context, callHandler);
      } catch (err: any) {
        expect(err.getResponse().code).toBe('VALIDATION_ERROR');
      }
    });

    it('AC-1: request pertama sukses -> menyimpan ke idempotency_keys dengan TTL 30 hari', async () => {
      prismaMock.idempotencyKey.findUnique.mockResolvedValue(null);
      prismaMock.idempotencyKey.create.mockResolvedValue({});

      const req = {
        method: 'POST',
        baseUrl: '/transactions',
        path: '',
        user: { userId },
        body: { amount: 50000, client_tx_id: validUlid1 },
        headers: {},
      };
      const res: any = { statusCode: 201 };
      const context = createMockContext(req, res);
      const callHandler = createMockCallHandler({ id: 'tx-1', status: 'POSTED' });

      const stream$ = await interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(stream$);

      expect(result).toEqual({ id: 'tx-1', status: 'POSTED' });
      expect(prismaMock.idempotencyKey.create).toHaveBeenCalledTimes(1);

      const createArg = prismaMock.idempotencyKey.create.mock.calls[0][0];
      expect(createArg.data.user_id).toBe(userId);
      expect(createArg.data.client_tx_id).toBe(validUlid1);
      expect(createArg.data.response_status).toBe(201);
      expect(createArg.data.response_body).toEqual({ id: 'tx-1', status: 'POSTED' });

      // Verifikasi TTL 30 hari (kurang lebih 30 hari dari sekarang)
      const now = Date.now();
      const expiresAt = createArg.data.ttl_expires_at.getTime();
      const diffDays = Math.round((expiresAt - now) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBe(30);
    });

    it('AC-1 (replay): retry request identik mengembalikan response persis tanpa memanggil callHandler', async () => {
      const cachedResponseBody = { id: 'tx-1', status: 'POSTED', amount: 50000 };
      const req = {
        method: 'POST',
        baseUrl: '/transactions',
        path: '',
        user: { userId },
        body: { amount: 50000, client_tx_id: validUlid1 },
        headers: {},
      };
      const expectedHash = computeRequestHash('POST', '/transactions', req.body);

      prismaMock.idempotencyKey.findUnique.mockResolvedValue({
        id: 'ik-1',
        user_id: userId,
        client_tx_id: validUlid1,
        request_hash: expectedHash,
        response_status: 201,
        response_body: cachedResponseBody,
        ttl_expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });

      const res: any = { statusCode: 201 };
      const context = createMockContext(req, res);
      const handleMock = jest.fn();
      const callHandler: CallHandler = {
        handle: handleMock as any,
      };

      const stream$ = await interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(stream$);

      expect(result).toEqual(cachedResponseBody);
      expect(handleMock).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('AC-2: reuse client_tx_id dengan payload berbeda melempar 409 IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD', async () => {
      const originalPayload = { amount: 50000 };
      const originalHash = computeRequestHash('POST', '/transactions', originalPayload);

      prismaMock.idempotencyKey.findUnique.mockResolvedValue({
        id: 'ik-1',
        user_id: userId,
        client_tx_id: validUlid1,
        request_hash: originalHash,
        response_status: 201,
        response_body: { id: 'tx-1' },
        ttl_expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });

      const newReq = {
        method: 'POST',
        baseUrl: '/transactions',
        path: '',
        user: { userId },
        body: { amount: 75000, client_tx_id: validUlid1 }, // nominal berbeda!
        headers: {},
      };
      const context = createMockContext(newReq);
      const callHandler = createMockCallHandler({});

      await expect(interceptor.intercept(context, callHandler)).rejects.toThrow(
        ConflictException,
      );
      try {
        await interceptor.intercept(context, callHandler);
      } catch (err: any) {
        expect(err.getResponse().code).toBe(
          'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
        );
      }
    });

    it('AC-4: jika baris sudah expired (ttl_expires_at <= now), baris lama dihapus dan eksekusi dilanjutkan', async () => {
      prismaMock.idempotencyKey.findUnique.mockResolvedValue({
        id: 'ik-expired',
        user_id: userId,
        client_tx_id: validUlid1,
        request_hash: 'some-old-hash',
        response_status: 201,
        response_body: { id: 'old-tx' },
        ttl_expires_at: new Date(Date.now() - 1000 * 60), // expired 1 menit lalu
      });
      prismaMock.idempotencyKey.delete.mockResolvedValue({});
      prismaMock.idempotencyKey.create.mockResolvedValue({});

      const req = {
        method: 'POST',
        baseUrl: '/transactions',
        path: '',
        user: { userId },
        body: { amount: 50000, client_tx_id: validUlid1 },
        headers: {},
      };
      const context = createMockContext(req);
      const callHandler = createMockCallHandler({ id: 'new-tx', status: 'POSTED' });

      const stream$ = await interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(stream$);

      expect(prismaMock.idempotencyKey.delete).toHaveBeenCalledWith({
        where: {
          user_id_client_tx_id: {
            user_id: userId,
            client_tx_id: validUlid1,
          },
        },
      });
      expect(result).toEqual({ id: 'new-tx', status: 'POSTED' });
    });

    it('tidak menyimpan ke idempotency_keys jika handler melempar error (4xx/5xx)', async () => {
      prismaMock.idempotencyKey.findUnique.mockResolvedValue(null);

      const req = {
        method: 'POST',
        baseUrl: '/transactions',
        path: '',
        user: { userId },
        body: { amount: 50000, client_tx_id: validUlid1 },
        headers: {},
      };
      const context = createMockContext(req);
      const callHandler: CallHandler = {
        handle: () =>
          throwError(() => new ConflictException({ code: 'INSUFFICIENT_BALANCE' })),
      };

      const stream$ = await interceptor.intercept(context, callHandler);
      await expect(lastValueFrom(stream$)).rejects.toThrow(ConflictException);

      expect(prismaMock.idempotencyKey.create).not.toHaveBeenCalled();
    });

    it('menangani race condition paralel P2002 dengan membaca baris pemenang', async () => {
      prismaMock.idempotencyKey.findUnique
        .mockResolvedValueOnce(null) // first lookup
        .mockResolvedValueOnce({
          // winner lookup after P2002
          id: 'ik-winner',
          user_id: userId,
          client_tx_id: validUlid1,
          request_hash: computeRequestHash('POST', '/transactions', { amount: 50000 }),
          response_status: 201,
          response_body: { id: 'tx-winner', status: 'POSTED' },
          ttl_expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24),
        });

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint violation',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
        },
      );
      prismaMock.idempotencyKey.create.mockRejectedValue(p2002Error);

      const req = {
        method: 'POST',
        baseUrl: '/transactions',
        path: '',
        user: { userId },
        body: { amount: 50000, client_tx_id: validUlid1 },
        headers: {},
      };
      const res: any = { statusCode: 201 };
      const context = createMockContext(req, res);
      const callHandler = createMockCallHandler({ id: 'my-tx' });

      const stream$ = await interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(stream$);

      expect(result).toEqual({ id: 'tx-winner', status: 'POSTED' });
    });
  });
});
