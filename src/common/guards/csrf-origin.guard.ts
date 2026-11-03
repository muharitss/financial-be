import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class CsrfOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = (request.method || 'GET').toUpperCase();

    if (!MUTATING_METHODS.has(method)) {
      return true;
    }

    const rawAllowed = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
    const allowedOrigins = rawAllowed
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    const originHeader = request.headers['origin'];
    let origin = typeof originHeader === 'string' ? originHeader : undefined;

    if (!origin && request.headers['referer']) {
      const referer = Array.isArray(request.headers['referer'])
        ? request.headers['referer'][0]
        : request.headers['referer'];
      try {
        origin = new URL(referer).origin;
      } catch {
        origin = undefined;
      }
    }

    if (origin) {
      if (!allowedOrigins.includes(origin)) {
        throw new ForbiddenException({
          code: 'CSRF_ORIGIN_MISMATCH',
          message: 'Origin permintaan tidak diizinkan',
        });
      }
      return true;
    }

    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException({
        code: 'CSRF_ORIGIN_MISMATCH',
        message: 'Header Origin atau Referer wajib diisi pada lingkungan produksi',
      });
    }

    return true;
  }
}
