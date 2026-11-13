import { z } from 'zod';

const emptyToUndefined = (val: unknown) => (val === '' ? undefined : val);

export const queryAuditLogsSchema = z.object({
  actor_user_id: z.preprocess(emptyToUndefined, z.string().optional()),
  action: z.preprocess(emptyToUndefined, z.string().optional()),
  resource_type: z.preprocess(emptyToUndefined, z.string().optional()),
  resource_id: z.preprocess(emptyToUndefined, z.string().optional()),
  from: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal YYYY-MM-DD').optional(),
  ),
  to: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal YYYY-MM-DD').optional(),
  ),
  cursor: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type QueryAuditLogsDto = z.infer<typeof queryAuditLogsSchema>;

export interface AuditLogItem {
  id: string;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date | string;
}

export interface QueryAuditLogsResponse {
  items: AuditLogItem[];
  next_cursor: string | null;
}
