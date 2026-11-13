import { z } from 'zod';
import { UnprocessableEntityException } from '@nestjs/common';

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validatePushEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UnprocessableEntityException({
      code: 'INVALID_PUSH_ENDPOINT',
      message: 'Endpoint push harus merupakan URL valid',
    });
  }

  if (url.protocol !== 'https:') {
    throw new UnprocessableEntityException({
      code: 'INVALID_PUSH_ENDPOINT',
      message: 'Endpoint push harus menggunakan protokol https',
    });
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('169.254.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new UnprocessableEntityException({
      code: 'INVALID_PUSH_ENDPOINT',
      message: 'Endpoint push lokal atau internal tidak diizinkan',
    });
  }
}

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1, 'Endpoint wajib diisi'),
  keys: z.object({
    p256dh: z.string().min(1, 'p256dh key wajib diisi'),
    auth: z.string().min(1, 'auth key wajib diisi'),
  }),
});

export type PushSubscriptionDto = z.infer<typeof pushSubscriptionSchema>;

export const unsubscribePushSchema = z.object({
  endpoint: z.string().min(1, 'Endpoint wajib diisi'),
});

export type UnsubscribePushDto = z.infer<typeof unsubscribePushSchema>;

export const updatePreferencesSchema = z
  .object({
    budget_warning_80: z.boolean().optional(),
    budget_warning_100: z.boolean().optional(),
    scheduled_reminder: z.boolean().optional(),
    sync_failed: z.boolean().optional(),
    savings_achieved: z.boolean().optional(),
    weekly_summary: z.boolean().optional(),
    monthly_summary: z.boolean().optional(),
    quiet_hours_enabled: z.boolean().optional(),
    quiet_hours_start: z
      .string()
      .regex(TIME_REGEX, 'Format jam tidak valid (HH:mm)')
      .optional(),
    quiet_hours_end: z
      .string()
      .regex(TIME_REGEX, 'Format jam tidak valid (HH:mm)')
      .optional(),
  })
  .strict();

export type UpdatePreferencesDto = z.infer<typeof updatePreferencesSchema>;

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  unread_only: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) => val === 'true'),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const syncFailedSchema = z.object({
  failed_count: z.number().int().min(1),
});

export type SyncFailedDto = z.infer<typeof syncFailedSchema>;

