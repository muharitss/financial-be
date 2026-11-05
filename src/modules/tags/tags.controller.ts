import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import {
  CreateTagPipe,
  UpdateTagPipe,
  type CreateTagDto,
  type UpdateTagDto,
  type TagResponse,
} from './dto/tag.dto.js';
import { TagsService } from './tags.service.js';

@ApiTags('tags')
@ApiCookieAuth('__Host-duitku_session')
@Controller('tags')
@UseGuards(JwtAuthGuard)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  @ApiOperation({ summary: 'Mendapatkan daftar tag' })
  @ApiResponse({ status: 200, description: 'Daftar tag berhasil diambil' })
  async list(
    @CurrentUser() user: { userId: string; role?: string },
    @Query('include_archived') includeArchived?: string,
  ): Promise<TagResponse[]> {
    return this.tagsService.list(user.userId, includeArchived === 'true');
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Membuat tag baru' })
  @ApiResponse({ status: 201, description: 'Tag berhasil dibuat' })
  @ApiResponse({ status: 400, description: 'Validasi gagal' })
  @ApiResponse({ status: 409, description: 'Nama tag sudah dipakai' })
  @ApiResponse({ status: 422, description: 'Batas 50 tag aktif tercapai' })
  async create(
    @CurrentUser() user: { userId: string; role?: string },
    @Body(new CreateTagPipe()) dto: CreateTagDto,
  ): Promise<TagResponse> {
    return this.tagsService.create(user, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mengubah nama atau warna tag' })
  @ApiResponse({ status: 200, description: 'Tag berhasil diubah' })
  @ApiResponse({ status: 400, description: 'Validasi gagal' })
  @ApiResponse({ status: 404, description: 'Tag tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Tag diarsipkan atau nama tag sudah dipakai' })
  async update(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new UpdateTagPipe()) dto: UpdateTagDto,
  ): Promise<TagResponse> {
    return this.tagsService.update(user, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mengarsipkan tag (idempoten)' })
  @ApiResponse({ status: 200, description: 'Tag berhasil diarsipkan' })
  @ApiResponse({ status: 404, description: 'Tag tidak ditemukan' })
  async archive(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TagResponse> {
    return this.tagsService.archive(user, id);
  }
}
