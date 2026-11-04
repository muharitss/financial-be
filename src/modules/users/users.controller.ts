import {
  Controller,
  Get,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { UsersService, UserResponse } from './users.service.js';

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
}
