import {
  Controller,
  Get,
  Delete,
  Post,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { UsersService, UserResponse } from './users.service.js';
import {
  requestDeletionSchema,
  cancelDeletionSchema,
  type RequestDeletionDto,
  type CancelDeletionDto,
} from './dto/request-deletion.dto.js';

function clearAuthCookies(res: Response) {
  const isProd = process.env.NODE_ENV === 'production';
  const opts = { path: '/', secure: isProd, sameSite: 'lax' as const };
  res.clearCookie('__Host-duitku_session', opts);
  res.clearCookie('duitku_session', opts);
  res.clearCookie('__Host-duitku_rt', opts);
  res.clearCookie('duitku_rt', opts);
  res.clearCookie('csrf_token', opts);
}

@ApiTags('users')
@ApiCookieAuth('__Host-duitku_session')
@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Mendapatkan profil pengguna saat ini' })
  @ApiResponse({ status: 200, description: 'Data user berhasil diambil' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getMe(@CurrentUser() user: { userId: string }): Promise<UserResponse> {
    const profile = await this.usersService.findById(user?.userId);
    if (!profile) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        message: 'Sesi tidak valid',
      });
    }
    return profile;
  }

  @Delete('me')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Meminta penghapusan akun (soft-delete 30 hari)' })
  @ApiResponse({ status: 202, description: 'Permintaan penghapusan diterima' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid atau password salah' })
  @ApiResponse({ status: 422, description: 'Konfirmasi nama tampilan tidak sesuai' })
  async deleteMe(
    @CurrentUser() user: { userId: string },
    @Body(new ZodValidationPipe(requestDeletionSchema)) dto: RequestDeletionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const ipHash = createHash('sha256').update(clientIp).digest('hex');
    const userAgent =
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent']
        : undefined;

    const result = await this.usersService.requestDeletion(user?.userId, dto, {
      ipHash,
      userAgent,
    });

    clearAuthCookies(res);

    return result;
  }

  @Post('me/cancel-deletion')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Membatalkan permintaan penghapusan akun' })
  @ApiResponse({ status: 200, description: 'Akun berhasil diaktifkan kembali' })
  @ApiResponse({ status: 401, description: 'Email atau password salah' })
  async cancelDeletion(
    @Body(new ZodValidationPipe(cancelDeletionSchema)) dto: CancelDeletionDto,
    @Req() req: Request,
  ) {
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const ipHash = createHash('sha256').update(clientIp).digest('hex');
    const userAgent =
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent']
        : undefined;

    return this.usersService.cancelDeletion(dto, {
      ipHash,
      userAgent,
    });
  }
}
