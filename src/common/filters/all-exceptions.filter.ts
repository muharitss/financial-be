import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const traceId =
      (request as any)?.id ||
      (request.headers?.['x-request-id'] as string) ||
      '';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'Terjadi kesalahan pada server';
    let details: any = null;
    const isProd = process.env.NODE_ENV === 'production';

    if (
      (exception as any)?.code === 'LIMIT_FILE_SIZE' ||
      (exception as any)?.message === 'File too large'
    ) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      code = 'FILE_TOO_LARGE';
      message = 'Ukuran lampiran maksimal 5 MB';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, any>;

        if (typeof resObj.code === 'string') {
          code = resObj.code;
        } else if (status === HttpStatus.TOO_MANY_REQUESTS) {
          code = 'RATE_LIMIT_EXCEEDED';
        } else if (
          status === HttpStatus.BAD_REQUEST ||
          status === HttpStatus.UNPROCESSABLE_ENTITY
        ) {
          code = 'VALIDATION_ERROR';
        } else if (status === HttpStatus.UNAUTHORIZED) {
          code = 'UNAUTHORIZED';
        } else if (status === HttpStatus.FORBIDDEN) {
          code = 'FORBIDDEN';
        } else if (status === HttpStatus.NOT_FOUND) {
          code = 'NOT_FOUND';
        } else if (status === HttpStatus.CONFLICT) {
          code = 'CONFLICT';
        }

        if (typeof resObj.message === 'string') {
          message = resObj.message;
        } else if (Array.isArray(resObj.message)) {
          message = 'Validasi gagal';
          details = resObj.message;
        } else if (typeof resObj.error === 'string') {
          message = resObj.error;
        }

        if (resObj.details !== undefined) {
          details = resObj.details;
        }

        if (status === HttpStatus.TOO_MANY_REQUESTS && !resObj.message) {
          message = 'Terlalu banyak permintaan. Silakan coba beberapa saat lagi.';
        }
      } else if (typeof res === 'string') {
        message = res;
        if (status === HttpStatus.TOO_MANY_REQUESTS) {
          code = 'RATE_LIMIT_EXCEEDED';
        } else if (
          status === HttpStatus.BAD_REQUEST ||
          status === HttpStatus.UNPROCESSABLE_ENTITY
        ) {
          code = 'VALIDATION_ERROR';
        }
      }
    } else if (exception instanceof Error) {
      if (!isProd) {
        message = exception.message || 'Internal server error';
        details = exception.stack ? { stack: exception.stack } : null;
      }
    }

    const logMsg = `[${traceId}] ${request.method} ${request.url} - ${status} - ${code}: ${message}`;
    if (status >= 500) {
      this.logger.error(logMsg, (exception as Error)?.stack);
    } else if (status >= 400) {
      this.logger.warn(logMsg);
    }

    if (traceId && !response.getHeader('X-Request-Id')) {
      response.setHeader('X-Request-Id', traceId);
    }

    response.status(status).json({
      code,
      message,
      details,
      traceId,
    });
  }
}
