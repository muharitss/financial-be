import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  SetMetadata,
  UnprocessableEntityException,
  ConflictException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, from } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ULID_REGEX } from '../../modules/transactions/dto/transaction.dto.js';

export const IDEMPOTENT_KEY = 'idempotent';

export interface IdempotentOptions {
  requireUlid?: boolean;
}

export const Idempotent = (options: IdempotentOptions = { requireUlid: true }) =>
  SetMetadata(IDEMPOTENT_KEY, options);

export function removeClientTxId(body: unknown): unknown {
  if (!body || typeof body !== 'object') {
    return body;
  }
  if (Array.isArray(body)) {
    return body.map(removeClientTxId);
  }
  const { client_tx_id: _unused, ...rest } = body as Record<string, unknown>;
  return rest;
}

export function canonicalJson(val: unknown): string {
  if (val === null || val === undefined) {
    return '';
  }
  if (typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map((item) => canonicalJson(item)).join(',') + ']';
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    if (obj[k] !== undefined) {
      entries.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    }
  }
  return '{' + entries.join(',') + '}';
}

export function computeRequestHash(
  method: string,
  path: string,
  body: unknown,
): string {
  const bodyClean = removeClientTxId(body);
  const canonical = canonicalJson(bodyClean);
  const data = `${method.toUpperCase()}:${path}:${canonical}`;
  return createHash('sha256').update(data).digest('hex');
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If endpoint is not decorated with @Idempotent, pass through
    if (!options) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    // Do not save IdempotencyKey for unauthenticated requests
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) {
      return next.handle();
    }

    // 1. Ekstraksi key: ambil dari req.body?.client_tx_id atau header req.headers['idempotency-key']
    const bodyKey =
      req.body &&
      typeof req.body === 'object' &&
      typeof (req.body as Record<string, unknown>).client_tx_id === 'string' &&
      ((req.body as Record<string, unknown>).client_tx_id as string).trim() !== ''
        ? ((req.body as Record<string, unknown>).client_tx_id as string).trim()
        : undefined;

    const rawHeader = req.headers ? req.headers['idempotency-key'] : undefined;
    const headerStr = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const headerKey =
      typeof headerStr === 'string' && headerStr.trim() !== ''
        ? headerStr.trim()
        : undefined;

    // Jika keduanya ada tetapi nilainya berbeda -> tolak 422 VALIDATION_ERROR
    if (bodyKey && headerKey && bodyKey !== headerKey) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR',
        message: 'client_tx_id pada body dan header Idempotency-Key tidak boleh berbeda',
      });
    }

    // Jika keduanya tidak ada pada endpoint @Idempotent() -> tolak 422 MISSING_CLIENT_TX_ID
    const key = bodyKey ?? headerKey;
    if (!key) {
      throw new UnprocessableEntityException({
        code: 'MISSING_CLIENT_TX_ID',
        message: 'client_tx_id atau header Idempotency-Key wajib disertakan',
      });
    }

    // Validasi panjang key: 1..64 karakter
    if (key.length < 1 || key.length > 64) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR',
        message: 'Panjang client_tx_id harus antara 1 sampai 64 karakter',
      });
    }

    // Validasi format key: ULID wajib untuk endpoint transaksi jika requireUlid !== false
    const requireUlid = options.requireUlid ?? true;
    if (requireUlid && !ULID_REGEX.test(key)) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_ERROR',
        message: 'Format client_tx_id tidak valid (harus ULID)',
      });
    }

    // Normalize: ensure req.body has client_tx_id populated if body is an object
    if (req.body && typeof req.body === 'object' && !(req.body as Record<string, unknown>).client_tx_id) {
      (req.body as Record<string, unknown>).client_tx_id = key;
    }

    // 2. Canonical Request Hash (SHA-256)
    const method = (req.method || 'POST').toUpperCase();
    const path = (req.baseUrl || '') + (req.path || (req.url ? req.url.split('?')[0] : ''));
    const requestHash = computeRequestHash(method, path, req.body);

    // 3. Lookup di idempotency_keys
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: {
        user_id_client_tx_id: {
          user_id: userId,
          client_tx_id: key,
        },
      },
    });

    const now = new Date();
    if (existing) {
      if (existing.ttl_expires_at > now) {
        if (existing.request_hash !== requestHash) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
            message: 'client_tx_id sudah digunakan dengan payload berbeda',
          });
        }

        // Replay identical response
        if (typeof res?.status === 'function') {
          res.status(existing.response_status);
        } else if (res) {
          res.statusCode = existing.response_status;
        }
        return of(existing.response_body);
      } else {
        // Expired row: delete and continue new execution
        await this.prisma.idempotencyKey.delete({
          where: {
            user_id_client_tx_id: {
              user_id: userId,
              client_tx_id: key,
            },
          },
        });
      }
    }

    // 4. Eksekusi handler dan simpan saat sukses (2xx)
    return next.handle().pipe(
      switchMap(async (responseBody) => {
        const statusCode = res?.statusCode ?? (method === 'POST' ? 201 : 200);

        if (statusCode >= 200 && statusCode < 300) {
          const ttlExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
          try {
            await this.prisma.idempotencyKey.create({
              data: {
                user_id: userId,
                client_tx_id: key,
                request_hash: requestHash,
                response_status: statusCode,
                response_body: (responseBody === undefined ? null : responseBody) as Prisma.InputJsonValue,
                ttl_expires_at: ttlExpiresAt,
              },
            });
          } catch (err: unknown) {
            // Race condition: P2002 on (user_id, client_tx_id)
            if (
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === 'P2002'
            ) {
              const winner = await this.prisma.idempotencyKey.findUnique({
                where: {
                  user_id_client_tx_id: {
                    user_id: userId,
                    client_tx_id: key,
                  },
                },
              });
              if (winner) {
                if (winner.request_hash !== requestHash) {
                  throw new ConflictException({
                    code: 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
                    message: 'client_tx_id sudah digunakan dengan payload berbeda',
                  });
                }
                if (typeof res?.status === 'function') {
                  res.status(winner.response_status);
                } else if (res) {
                  res.statusCode = winner.response_status;
                }
                return winner.response_body;
              }
            }
            throw err;
          }
        }
        return responseBody;
      }),
      catchError((err: unknown) => {
        return from(
          (async () => {
            // If another parallel request won and committed transaction first
            if (
              err instanceof ConflictException &&
              (err.getResponse() as Record<string, unknown>)?.code === 'CLIENT_TX_ID_DUPLICATE'
            ) {
              const winner = await this.prisma.idempotencyKey.findUnique({
                where: {
                  user_id_client_tx_id: {
                    user_id: userId,
                    client_tx_id: key,
                  },
                },
              });
              if (winner) {
                if (winner.request_hash !== requestHash) {
                  throw new ConflictException({
                    code: 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
                    message: 'client_tx_id sudah digunakan dengan payload berbeda',
                  });
                }
                if (typeof res?.status === 'function') {
                  res.status(winner.response_status);
                } else if (res) {
                  res.statusCode = winner.response_status;
                }
                return winner.response_body;
              }
            }
            throw err;
          })(),
        );
      }),
    );
  }
}
