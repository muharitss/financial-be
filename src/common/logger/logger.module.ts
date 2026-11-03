import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

export function sanitizeLogPayload<T = any>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeLogPayload(item)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const sensitivePattern = /amount|nominal|balance|email|phone|password|token/i;
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (sensitivePattern.test(key)) {
        continue;
      }
      sanitized[key] = sanitizeLogPayload(value);
    }
    return sanitized as T;
  }

  return obj;
}

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || 'info';

@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: logLevel,
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'password',
          'token',
          '*.password',
          '*.token',
        ],
        genReqId: (req, res) => {
          const existingId = req.headers['x-request-id'] || (req as any).id;
          if (existingId) return existingId;
          const newId = randomUUID();
          res.setHeader('X-Request-Id', newId);
          return newId;
        },
        customLogLevel: (req, res, err) => {
          if (req.url === '/health' || (req as any).path === '/health') {
            return 'silent';
          }
          if (res.statusCode >= 500 || err) {
            return 'error';
          }
          if (res.statusCode >= 400) {
            return 'warn';
          }
          return 'info';
        },
        autoLogging: {
          ignore: (req) => req.url === '/health' || (req as any).path === '/health',
        },
        transport: !isProduction
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: true,
                translateTime: 'SYS:standard',
              },
            }
          : undefined,
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
