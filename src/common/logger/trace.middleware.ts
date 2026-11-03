import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const rawHeader = req.headers['x-request-id'];
    const traceId =
      typeof rawHeader === 'string' && rawHeader.trim() !== ''
        ? rawHeader.trim()
        : Array.isArray(rawHeader) && rawHeader[0]
          ? rawHeader[0].trim()
          : randomUUID();

    (req as any).id = traceId;
    res.setHeader('X-Request-Id', traceId);

    next();
  }
}
