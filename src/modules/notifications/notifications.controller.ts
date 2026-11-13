import {
  Controller,
  Post,
  Delete,
  Get,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { NotificationsService } from './notifications.service.js';
import {
  pushSubscriptionSchema,
  unsubscribePushSchema,
  updatePreferencesSchema,
  listNotificationsQuerySchema,
  syncFailedSchema,
  type PushSubscriptionDto,
  type UnsubscribePushDto,
  type UpdatePreferencesDto,
  type ListNotificationsQuery,
  type SyncFailedDto,
} from './dto/notifications.dto.js';

@ApiTags('notifications')
@ApiCookieAuth('__Host-duitku_session')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Mendapatkan daftar notifikasi in-app' })
  @ApiResponse({ status: 200, description: 'Daftar notifikasi dan unread count' })
  async list(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery,
  ) {
    return this.notificationsService.list(user.userId, query);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Menandai notifikasi telah dibaca' })
  @ApiResponse({ status: 200, description: 'Notifikasi berhasil ditandai dibaca' })
  @ApiResponse({ status: 404, description: 'Notifikasi tidak ditemukan' })
  async markRead(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markRead(user.userId, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Menandai semua notifikasi telah dibaca' })
  @ApiResponse({ status: 200, description: 'Semua notifikasi berhasil ditandai dibaca' })
  async markAllRead(@CurrentUser() user: { userId: string }) {
    return this.notificationsService.markAllRead(user.userId);
  }

  @Post('sync-failed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Melaporkan kegagalan sinkronisasi offline' })
  @ApiResponse({ status: 200, description: 'Laporan sync failed diproses' })
  async syncFailed(
    @CurrentUser() user: { userId: string },
    @Body(new ZodValidationPipe(syncFailedSchema)) dto: SyncFailedDto,
  ) {
    const notification = await this.notificationsService.reportSyncFailed(
      user.userId,
      dto.failed_count,
    );
    return { success: true, notification };
  }

  @Post('push-subscriptions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Mendaftarkan endpoint Web Push' })
  @ApiResponse({ status: 201, description: 'Push subscription berhasil disimpan' })
  @ApiResponse({ status: 422, description: 'Endpoint tidak valid atau lokal (anti-SSRF)' })
  async subscribePush(
    @CurrentUser() user: { userId: string },
    @Req() req: Request,
    @Body(new ZodValidationPipe(pushSubscriptionSchema)) dto: PushSubscriptionDto,
  ) {
    const userAgent = req.headers['user-agent'];
    return this.notificationsService.subscribePush(user.userId, dto, userAgent);
  }

  @Delete('push-subscriptions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Menghapus endpoint Web Push' })
  @ApiResponse({ status: 200, description: 'Push subscription berhasil dihapus' })
  async unsubscribePush(
    @CurrentUser() user: { userId: string },
    @Body(new ZodValidationPipe(unsubscribePushSchema)) dto: UnsubscribePushDto,
  ) {
    return this.notificationsService.unsubscribePush(user.userId, dto.endpoint);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Mendapatkan preferensi notifikasi user' })
  @ApiResponse({ status: 200, description: 'Preferensi notifikasi' })
  async getPreferences(@CurrentUser() user: { userId: string }) {
    return this.notificationsService.getPreferences(user.userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Memperbarui preferensi notifikasi user' })
  @ApiResponse({ status: 200, description: 'Preferensi berhasil diperbarui' })
  @ApiResponse({ status: 400, description: 'Validasi gagal' })
  async updatePreferences(
    @CurrentUser() user: { userId: string },
    @Body(new ZodValidationPipe(updatePreferencesSchema)) dto: UpdatePreferencesDto,
  ) {
    return this.notificationsService.updatePreferences(user.userId, dto);
  }
}
