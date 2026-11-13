import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { QueryAuditLogsDto, QueryAuditLogsResponse } from './dto/audit.dto.js';

const REDACT_KEY_REGEX =
  /(amount|balance|fee|reserved|available|carryover|nominal|target|spent|remaining|note|storage_key|access_url)/i;

export function redactAuditSnapshotForSuperadmin(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactAuditSnapshotForSuperadmin);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEY_REGEX.test(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactAuditSnapshotForSuperadmin(v);
      }
    }
    return result;
  }
  return value;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async queryLogs(
    admin: { userId?: string; id?: string; role?: string },
    query: QueryAuditLogsDto,
    reqMeta?: RequestMeta,
  ): Promise<QueryAuditLogsResponse> {
    const actorUserId = admin.userId || admin.id || null;
    const actorRole = admin.role || 'SUPERADMIN';
    const clientIp = reqMeta?.ip || '127.0.0.1';
    const ipHash = createHash('sha256').update(clientIp).digest('hex');
    const userAgent = reqMeta?.userAgent ? reqMeta.userAgent.slice(0, 255) : null;

    // Meta-audit log (FR-AUDIT-004)
    await this.prisma.auditLog.create({
      data: {
        action: 'AUDIT_LOG_QUERY',
        resource_type: 'audit_log',
        actor_user_id: actorUserId,
        actor_role: actorRole,
        after: { query: query as any },
        ip_address: ipHash,
        user_agent: userAgent,
      },
    });

    const where: Record<string, any> = {};
    if (query.actor_user_id) {
      where.actor_user_id = query.actor_user_id;
    }
    if (query.action) {
      where.action = query.action;
    }
    if (query.resource_type) {
      where.resource_type = query.resource_type;
    }
    if (query.resource_id) {
      where.resource_id = query.resource_id;
    }
    if (query.from || query.to) {
      where.created_at = {};
      if (query.from) {
        where.created_at.gte = new Date(`${query.from}T00:00:00.000Z`);
      }
      if (query.to) {
        where.created_at.lte = new Date(`${query.to}T23:59:59.999Z`);
      }
    }

    const limit = query.limit ?? 50;

    const records = await this.prisma.auditLog.findMany({
      where,
      take: limit + 1,
      ...(query.cursor
        ? {
            cursor: { id: query.cursor },
            skip: 1,
          }
        : {}),
      orderBy: [
        { created_at: 'desc' },
        { id: 'desc' },
      ],
    });

    const hasMore = records.length > limit;
    const sliced = hasMore ? records.slice(0, limit) : records;
    const next_cursor =
      hasMore && sliced.length > 0 ? sliced[sliced.length - 1].id : null;

    const items = sliced.map((item) => ({
      id: item.id,
      actor_user_id: item.actor_user_id,
      actor_role: item.actor_role,
      action: item.action,
      resource_type: item.resource_type,
      resource_id: item.resource_id,
      before: redactAuditSnapshotForSuperadmin(item.before),
      after: redactAuditSnapshotForSuperadmin(item.after),
      ip_address: item.ip_address,
      user_agent: item.user_agent,
      created_at: item.created_at,
    }));

    return { items, next_cursor };
  }
}
