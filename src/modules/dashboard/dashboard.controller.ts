import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { DashboardService, DashboardBalancesResponse } from './dashboard.service.js';
import {
  dateRangeSchema,
  cashFlowQuerySchema,
  type DateRangeDto,
  type CashFlowQueryDto,
  type DashboardSummaryResponse,
  type DashboardCashFlowResponse,
  type DashboardCategoryBreakdownResponse,
  type DashboardBalanceTrendResponse,
} from './dto/dashboard.dto.js';

@ApiTags('dashboard')
@ApiCookieAuth('__Host-duitku_session')
@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('balances')
  @ApiOperation({ summary: 'Mendapatkan ringkasan saldo tiga angka dashboard' })
  @ApiResponse({ status: 200, description: 'Ringkasan saldo dashboard berhasil diambil' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getBalances(
    @CurrentUser() user: { userId: string },
  ): Promise<DashboardBalancesResponse> {
    return this.dashboardService.getBalances(user.userId);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Mendapatkan ringkasan pemasukan, pengeluaran, dan net' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiResponse({ status: 200, description: 'Ringkasan pemasukan/pengeluaran berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format tanggal tidak valid atau from > to' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getSummary(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeDto,
  ): Promise<DashboardSummaryResponse> {
    return this.dashboardService.getSummary(user.userId, query);
  }

  @Get('cash-flow')
  @ApiOperation({ summary: 'Mendapatkan ringkasan arus kas bulanan' })
  @ApiQuery({ name: 'months', required: false, type: Number, description: 'Jumlah bulan (1..12, default 6)' })
  @ApiResponse({ status: 200, description: 'Ringkasan arus kas berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Parameter months tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getCashFlow(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(cashFlowQuerySchema)) query: CashFlowQueryDto,
  ): Promise<DashboardCashFlowResponse> {
    return this.dashboardService.getCashFlow(user.userId, query.months);
  }

  @Get('categories')
  @ApiOperation({ summary: 'Mendapatkan rincian pengeluaran per kategori' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiResponse({ status: 200, description: 'Rincian pengeluaran per kategori berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format tanggal tidak valid atau from > to' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getCategories(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeDto,
  ): Promise<DashboardCategoryBreakdownResponse> {
    return this.dashboardService.getCategoryBreakdown(user.userId, query);
  }

  @Get('balance-trend')
  @ApiOperation({ summary: 'Mendapatkan data tren saldo (chart)' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiResponse({ status: 200, description: 'Data tren saldo berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format tanggal tidak valid atau from > to' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getBalanceTrend(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeDto,
  ): Promise<DashboardBalanceTrendResponse> {
    return this.dashboardService.getBalanceTrend(user.userId, query);
  }
}
