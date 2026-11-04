import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export const USER_OWNED_MODELS = new Set([
  'FinancialProfile',
  'UserPreference',
  'NotificationPreference',
  'Account',
  'Category',
  'Tag',
  'Transaction',
  'Budget',
  'SavingsGoal',
  'Notification',
  'IdempotencyKey',
  'RefreshToken',
]);

const USER_OWNED_MODELS_LOWER = new Set(
  Array.from(USER_OWNED_MODELS).map((m) => m.toLowerCase()),
);

const READ_WRITE_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

function hasUserId(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.user_id !== undefined && obj.user_id !== null && obj.user_id !== '') {
    return true;
  }
  if (Array.isArray(obj.AND)) {
    return obj.AND.some((item: any) => hasUserId(item));
  }
  return false;
}

export function validateTenantIsolation(
  model?: string,
  operation?: string,
  args?: any,
): void {
  if (!model || !USER_OWNED_MODELS_LOWER.has(model.toLowerCase())) {
    return;
  }

  if (operation === 'create') {
    if (!hasUserId(args?.data)) {
      throw new ForbiddenException({
        code: 'TENANT_ISOLATION_VIOLATION',
        message: 'Missing user_id filter',
      });
    }
    return;
  }

  if (operation === 'createMany') {
    const data = args?.data;
    const items = Array.isArray(data) ? data : data ? [data] : [];
    if (items.length === 0 || !items.every(hasUserId)) {
      throw new ForbiddenException({
        code: 'TENANT_ISOLATION_VIOLATION',
        message: 'Missing user_id filter',
      });
    }
    return;
  }

  if (operation === 'upsert') {
    if (!hasUserId(args?.where) || !hasUserId(args?.create)) {
      throw new ForbiddenException({
        code: 'TENANT_ISOLATION_VIOLATION',
        message: 'Missing user_id filter',
      });
    }
    return;
  }

  if (operation && READ_WRITE_OPERATIONS.has(operation)) {
    if (!hasUserId(args?.where)) {
      throw new ForbiddenException({
        code: 'TENANT_ISOLATION_VIOLATION',
        message: 'Missing user_id filter',
      });
    }
    return;
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly extendedClient: any;

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'production'
          ? ['warn', 'error']
          : ['warn', 'error', 'info', 'query'],
    });

    const base = this;
    (base as any).asSystem = () => base;

    this.extendedClient = this.$extends({
      client: {
        asSystem() {
          return base;
        },
      },
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            validateTenantIsolation(model, operation, args);
            return query(args);
          },
        },
      },
    });

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === 'asSystem') {
          return () => base;
        }
        if (prop in target.extendedClient) {
          const val = target.extendedClient[prop];
          return typeof val === 'function' ? val.bind(target.extendedClient) : val;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  asSystem(): PrismaClient {
    return this;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
