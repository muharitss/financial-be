import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Headers,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { SuperadminGuard } from '../../common/guards/superadmin.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AuditService } from './audit.service.js';
import {
  BreakGlassService,
  RequestBreakGlassSchema,
  type RequestBreakGlassDto,
} from './break-glass.service.js';
import { queryAuditLogsSchema, type QueryAuditLogsDto } from './dto/audit.dto.js';

@ApiTags('Admin Audit')
@ApiCookieAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, SuperadminGuard)
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly breakGlassService: BreakGlassService,
  ) {}

  @Get('audit-logs')
  @ApiOperation({ summary: 'Query audit logs (Superadmin only, redacted, append-only)' })
  @ApiResponse({ status: 200, description: 'Daftar log audit yang telah diredaksi' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — Superadmin required' })
  async getAuditLogs(
    @CurrentUser() admin: { userId: string; role?: string },
    @Query(new ZodValidationPipe(queryAuditLogsSchema)) query: QueryAuditLogsDto,
    @Req() req: Request,
  ) {
    const rawIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'];
    return this.auditService.queryLogs(admin, query, {
      ip: rawIp,
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
    });
  }

  @Post('break-glass')
  @ApiOperation({ summary: 'Minta akses darurat break-glass (Superadmin only, DPO/Owner approval)' })
  @ApiResponse({ status: 201, description: 'Akses break-glass diberikan' })
  @ApiResponse({ status: 400, description: 'Validation error atau self-target' })
  @ApiResponse({ status: 403, description: 'Header approval tidak valid atau bukan Superadmin' })
  @ApiResponse({ status: 404, description: 'Target user tidak ditemukan' })
  @ApiResponse({ status: 503, description: 'Fitur break-glass disabled' })
  async requestBreakGlass(
    @CurrentUser() admin: { userId: string },
    @Headers('x-break-glass-approval') approvalHeader: string | undefined,
    @Body(new ZodValidationPipe(RequestBreakGlassSchema)) body: RequestBreakGlassDto,
  ) {
    return this.breakGlassService.requestAccess(admin.userId, body, approvalHeader);
  }

  @Post('break-glass/:id/revoke')
  @ApiOperation({ summary: 'Cabut akses darurat break-glass secara manual' })
  @ApiResponse({ status: 200, description: 'Akses break-glass berhasil dicabut' })
  @ApiResponse({ status: 404, description: 'Grant tidak ditemukan' })
  async revokeBreakGlass(
    @CurrentUser() admin: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.breakGlassService.revokeAccess(admin.userId, id);
  }

  @Get('break-glass/:id/audit-logs')
  @ApiOperation({ summary: 'Baca audit logs target user via sesi break-glass aktif' })
  @ApiResponse({ status: 200, description: 'Audit logs target user dengan lampiran diredaksi' })
  @ApiResponse({ status: 403, description: 'Break-glass expired, revoked, atau bukan milik admin' })
  @ApiResponse({ status: 404, description: 'Grant tidak ditemukan' })
  async getTargetAuditLogs(
    @CurrentUser() admin: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.breakGlassService.readTargetAuditLogs(admin.userId, id);
  }
}
