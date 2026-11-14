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
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  createCategorySchema,
  updateCategorySchema,
  type CreateCategoryDto,
  type UpdateCategoryDto,
  type CategoryResponse,
} from './dto/category.dto.js';
import { CategoriesService } from './categories.service.js';

@ApiTags('categories')
@ApiCookieAuth('__Host-duitku_session')
@Controller('categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'Mendapatkan daftar kategori' })
  @ApiResponse({ status: 200, description: 'Daftar kategori berhasil diambil' })
  async list(
    @CurrentUser() user: { userId: string },
    @Query('include_archived') includeArchived?: string,
  ): Promise<CategoryResponse[]> {
    return this.categoriesService.list(user.userId, includeArchived === 'true');
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Membuat kategori baru' })
  @ApiResponse({ status: 201, description: 'Kategori berhasil dibuat' })
  @ApiResponse({ status: 400, description: 'Data tidak valid' })
  @ApiResponse({ status: 404, description: 'Profil atau kategori induk tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Nama kategori sudah dipakai' })
  @ApiResponse({ status: 422, description: 'Aturan hierarki atau jenis kategori tidak valid' })
  async create(
    @CurrentUser() user: { userId: string; role?: string },
    @Body(new ZodValidationPipe(createCategorySchema)) dto: CreateCategoryDto,
  ): Promise<CategoryResponse> {
    return this.categoriesService.create(user, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mengubah nama kategori' })
  @ApiResponse({ status: 200, description: 'Kategori berhasil diperbarui' })
  @ApiResponse({ status: 400, description: 'Data tidak valid' })
  @ApiResponse({ status: 404, description: 'Kategori tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Kategori diarsipkan atau nama sudah dipakai' })
  async update(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) dto: UpdateCategoryDto,
  ): Promise<CategoryResponse> {
    return this.categoriesService.update(user, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mengarsipkan kategori (idempoten)' })
  @ApiResponse({ status: 200, description: 'Kategori berhasil diarsipkan' })
  @ApiResponse({ status: 404, description: 'Kategori tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Kategori sistem tidak dapat diarsipkan' })
  async archive(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CategoryResponse> {
    return this.categoriesService.archive(user, id);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Memulihkan kategori dari arsip (idempoten)' })
  @ApiResponse({ status: 200, description: 'Kategori berhasil dipulihkan' })
  @ApiResponse({ status: 404, description: 'Kategori tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Kategori induk masih diarsipkan' })
  async unarchive(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CategoryResponse> {
    return this.categoriesService.unarchive(user, id);
  }
}
