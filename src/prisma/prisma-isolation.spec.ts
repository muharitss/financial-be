import { describe, it, expect } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import {
  USER_OWNED_MODELS,
  validateTenantIsolation,
  PrismaService,
} from './prisma.service.js';

describe('Prisma Tenant Isolation Guard', () => {
  describe('validateTenantIsolation', () => {
    const userOwnedList = Array.from(USER_OWNED_MODELS);

    userOwnedList.forEach((model) => {
      it(`menolak query baca/tulis tanpa user_id pada model ${model}`, () => {
        const operations = [
          'findMany',
          'findFirst',
          'findUnique',
          'count',
          'aggregate',
          'update',
          'updateMany',
          'delete',
          'deleteMany',
        ];

        for (const op of operations) {
          expect(() => {
            validateTenantIsolation(model, op, { where: { id: 'some-id' } });
          }).toThrow(ForbiddenException);

          try {
            validateTenantIsolation(model, op, { where: {} });
          } catch (err: any) {
            expect(err).toBeInstanceOf(ForbiddenException);
            const res = err.getResponse();
            expect(res.code).toBe('TENANT_ISOLATION_VIOLATION');
            expect(res.message).toBe('Missing user_id filter');
          }
        }
      });

      it(`menolak operasi create tanpa user_id pada model ${model}`, () => {
        expect(() => {
          validateTenantIsolation(model, 'create', { data: { name: 'Test' } });
        }).toThrow(ForbiddenException);
      });

      it(`menolak operasi createMany tanpa user_id pada model ${model}`, () => {
        expect(() => {
          validateTenantIsolation(model, 'createMany', {
            data: [{ name: 'Test 1' }, { user_id: 'u1', name: 'Test 2' }],
          });
        }).toThrow(ForbiddenException);
      });

      it(`menolak operasi upsert tanpa user_id pada model ${model}`, () => {
        expect(() => {
          validateTenantIsolation(model, 'upsert', {
            where: { id: 'some-id' },
            create: { name: 'Test' },
          });
        }).toThrow(ForbiddenException);
      });

      it(`mengizinkan query jika user_id disertakan pada model ${model}`, () => {
        expect(() => {
          validateTenantIsolation(model, 'findMany', {
            where: { user_id: 'user-uuid-1' },
          });
        }).not.toThrow();

        expect(() => {
          validateTenantIsolation(model, 'findMany', {
            where: { AND: [{ user_id: 'user-uuid-1' }] },
          });
        }).not.toThrow();

        expect(() => {
          validateTenantIsolation(model, 'create', {
            data: { user_id: 'user-uuid-1', name: 'Item' },
          });
        }).not.toThrow();

        expect(() => {
          validateTenantIsolation(model, 'createMany', {
            data: [
              { user_id: 'user-uuid-1', name: 'Item 1' },
              { user_id: 'user-uuid-1', name: 'Item 2' },
            ],
          });
        }).not.toThrow();

        expect(() => {
          validateTenantIsolation(model, 'upsert', {
            where: { user_id: 'user-uuid-1' },
            create: { user_id: 'user-uuid-1', name: 'Item' },
          });
        }).not.toThrow();
      });
    });

    it('mengizinkan query pada model yang bukan milik user tanpa filter user_id', () => {
      expect(() => {
        validateTenantIsolation('User', 'findMany', { where: {} });
      }).not.toThrow();

      expect(() => {
        validateTenantIsolation('User', 'findUnique', {
          where: { email: 'user@example.com' },
        });
      }).not.toThrow();
    });
  });

  describe('PrismaService Client Extension', () => {
    const prisma = new PrismaService();

    it('menolak query pada model milik user tanpa user_id melalui client', async () => {
      await expect(prisma.account.findMany({})).rejects.toThrow(
        ForbiddenException,
      );

      try {
        await prisma.account.findMany({});
      } catch (err: any) {
        expect(err.getResponse()).toEqual({
          code: 'TENANT_ISOLATION_VIOLATION',
          message: 'Missing user_id filter',
        });
      }

      await expect(prisma.transaction.findFirst({})).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        prisma.refreshToken.findUnique({
          where: { token_hash: 'abc' } as any,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('AC-4: menolak operasi update, delete, deleteMany pada AuditLog dan TransactionAudit melalui client aplikasi', async () => {
      await expect(
        prisma.auditLog.update({ where: { id: '00000000-0000-0000-0000-000000000000' }, data: {} } as any),
      ).rejects.toThrow(ForbiddenException);

      try {
        await prisma.auditLog.update({ where: { id: '00000000-0000-0000-0000-000000000000' }, data: {} } as any);
      } catch (err: any) {
        expect(err.getResponse()).toEqual({
          code: 'AUDIT_LOG_IMMUTABLE',
          message: 'Audit log bersifat append-only',
        });
      }

      await expect(
        prisma.auditLog.delete({ where: { id: '00000000-0000-0000-0000-000000000000' } } as any),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        prisma.transactionAudit.deleteMany({} as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('asSystem() mengembalikan base client yang membypass isolasi tenant', () => {
      const systemClient = prisma.asSystem();
      expect(systemClient).toBeDefined();
      expect(typeof systemClient.asSystem).toBe('function');
      expect(systemClient.asSystem()).toBe(systemClient);
    });
  });
});
