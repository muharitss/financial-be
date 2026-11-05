import {
  Controller,
  Post,
  Patch,
  Get,
  Query,
  Param,
  ParseUUIDPipe,
  Body,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  BudgetsService,
  BudgetResponse,
  BudgetOverviewResponse,
  BudgetUsageItem,
} from './budgets.service.js';
import {
  createBudgetSchema,
  updateBudgetSchema,
  budgetQuerySchema,
  type CreateBudgetDto,
  type UpdateBudgetDto,
  type BudgetQueryDto,
} from './dto/budget.dto.js';

@ApiTags('budgets')
@ApiCookieAuth('__Host-duitku_session')
@Controller('budgets')
@UseGuards(JwtAuthGuard)
export class BudgetsController {
  constructor(private readonly budgetsService: BudgetsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Membuat anggaran baru (total atau kategori)' })
  @ApiResponse({ status: 201, description: 'Anggaran berhasil dibuat' })
  @ApiResponse({ status: 400, description: 'Data tidak valid atau kategori bukan EXPENSE' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Kategori atau akun tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Anggaran sudah ada, akun diarsipkan, atau periode terkunci' })
  @ApiResponse({ status: 422, description: 'Rollover tidak diizinkan pada total atau kategori diarsipkan' })
  async create(
    @CurrentUser() user: { userId: string; role?: string },
    @Body(new ZodValidationPipe(createBudgetSchema)) dto: CreateBudgetDto,
  ): Promise<BudgetResponse> {
    return this.budgetsService.create(user, dto);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mendapatkan ringkasan anggaran dan penggunaan per periode' })
  @ApiQuery({ name: 'period', required: false, description: 'Periode YYYY-MM (default: bulan berjalan)' })
  @ApiResponse({ status: 200, description: 'Ringkasan anggaran berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format periode tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getOverview(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(budgetQuerySchema)) query: BudgetQueryDto,
  ): Promise<BudgetOverviewResponse> {
    return this.budgetsService.getOverview(user.userId, query.period);
  }

  @Get(':id/usage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mendapatkan detail penggunaan satu anggaran per periode' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID anggaran' })
  @ApiQuery({ name: 'period', required: false, description: 'Periode YYYY-MM (default: bulan berjalan)' })
  @ApiResponse({ status: 200, description: 'Penggunaan anggaran berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format periode atau ID tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Anggaran tidak ditemukan' })
  async getSingleUsage(
    @CurrentUser() user: { userId: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(budgetQuerySchema)) query: BudgetQueryDto,
  ): Promise<BudgetUsageItem> {
    return this.budgetsService.getSingleUsage(user.userId, id, query.period);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Memperbarui anggaran (mid-month)' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID anggaran' })
  @ApiResponse({ status: 200, description: 'Anggaran berhasil diperbarui' })
  @ApiResponse({ status: 400, description: 'Data tidak valid atau id bukan UUID' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Anggaran atau akun tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Akun diarsipkan atau periode anggaran terkunci' })
  @ApiResponse({ status: 422, description: 'Rollover tidak diizinkan pada anggaran total' })
  async update(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateBudgetSchema)) dto: UpdateBudgetDto,
  ): Promise<BudgetResponse> {
    return this.budgetsService.update(user, id, dto);
  }
}
