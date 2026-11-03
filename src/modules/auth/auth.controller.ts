import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  Headers,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { registerSchema, loginSchema } from './dto/auth.dto.js';

function getCookieNames() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    session: isProd ? '__Host-duitku_session' : 'duitku_session',
    refresh: isProd ? '__Host-duitku_rt' : 'duitku_rt',
    csrf: 'csrf_token',
    isProd,
  };
}

function extractRefreshToken(req: Request): string | undefined {
  return (
    req.cookies?.['__Host-duitku_rt'] ??
    (process.env.NODE_ENV !== 'production' ? req.cookies?.['duitku_rt'] : undefined)
  );
}

@SkipThrottle()
@Throttle({ auth: { limit: 10, ttl: 60000 } })
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private setAuthCookies(
    res: Response,
    tokens: { sessionToken: string; refreshToken: string; csrfToken: string },
  ) {
    const { session, refresh, csrf, isProd } = getCookieNames();

    res.cookie(session, tokens.sessionToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 15 * 60 * 1000,
    });

    res.cookie(refresh, tokens.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.cookie(csrf, tokens.csrfToken, {
      httpOnly: false,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  private clearAuthCookies(res: Response) {
    const { session, refresh, csrf, isProd } = getCookieNames();
    const opts = { path: '/', secure: isProd, sameSite: 'lax' as const };
    res.clearCookie(session, opts);
    res.clearCookie(refresh, opts);
    res.clearCookie(csrf, opts);
  }

  @Post('register')
  @ApiOperation({ summary: 'Mendaftar akun baru dengan email dan password' })
  @ApiResponse({ status: 201, description: 'User berhasil didaftarkan' })
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Data registrasi tidak valid',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await this.authService.register(parsed.data);
    this.setAuthCookies(res, result);

    return { user: result.user };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login menggunakan email dan password' })
  @ApiResponse({ status: 200, description: 'Login berhasil' })
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Data login tidak valid',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const result = await this.authService.login(parsed.data, clientIp);
    this.setAuthCookies(res, result);

    return { user: result.user };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotasi access token dan refresh token dengan proteksi CSRF' })
  async refresh(
    @Req() req: Request,
    @Headers('x-csrf-token') csrfHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawRefreshToken = extractRefreshToken(req);
    const csrfCookie = req.cookies?.['csrf_token'];

    if (!rawRefreshToken) {
      throw new BadRequestException({
        code: 'MISSING_REFRESH_TOKEN',
        message: 'Refresh token tidak ditemukan di cookie',
      });
    }

    const result = await this.authService.refresh(rawRefreshToken, csrfCookie, csrfHeader);
    this.setAuthCookies(res, result);

    return { ok: true };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Keluar dan mencabut refresh token' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = extractRefreshToken(req);
    await this.authService.logout(rawRefreshToken);
    this.clearAuthCookies(res);

    return { ok: true };
  }
}
