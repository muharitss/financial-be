import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { SuperadminGuard } from '../../common/guards/superadmin.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AuditService } from './audit.service.js';
import { queryAuditLogsSchema, type QueryAuditLogsDto } from './dto/audit.dto.js';

@ApiTags('Admin Audit')
@ApiCookieAuth()
@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, SuperadminGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
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
}
