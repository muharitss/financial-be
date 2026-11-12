import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import {
  reportFilterSchema,
  type ReportFilter,
  type DashboardSummaryResponse,
  type DashboardCategoryBreakdownResponse,
} from '../dashboard/dto/dashboard.dto.js';
import { ReportsService } from './reports.service.js';
import {
  monthlyComparisonQuerySchema,
  type MonthlyComparisonQueryDto,
  type BalanceChangesResponse,
  type MonthlyComparisonResponse,
} from './dto/reports.dto.js';

@ApiTags('reports')
@ApiCookieAuth('__Host-duitku_session')
@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly reportsService: ReportsService,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Mendapatkan laporan ringkasan pemasukan dan pengeluaran',
    description:
      'FR-REPORTS-001. Untuk riwayat transaksi individual (FR-REPORTS-003), gunakan GET /transactions. Untuk ringkasan budget (FR-REPORTS-005), gunakan GET /budgets.',
  })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'account_id', required: false, type: [String], description: 'Filter UUID akun' })
  @ApiQuery({ name: 'category_id', required: false, type: [String], description: 'Filter UUID kategori' })
  @ApiResponse({ status: 200, description: 'Laporan ringkasan berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format filter atau tanggal tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getSummary(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(reportFilterSchema)) query: ReportFilter,
  ): Promise<DashboardSummaryResponse> {
    return this.dashboardService.getSummary(user.userId, query);
  }

  @Get('categories')
  @ApiOperation({
    summary: 'Mendapatkan laporan pengeluaran per kategori',
    description:
      'FR-REPORTS-002. Rincian pengeluaran per kategori dengan dukungan rollup subkategori. Untuk riwayat transaksi individual, rujuk ke GET /transactions. Untuk ringkasan pemakaian anggaran, rujuk ke GET /budgets.',
  })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'account_id', required: false, type: [String], description: 'Filter UUID akun' })
  @ApiQuery({ name: 'category_id', required: false, type: [String], description: 'Filter UUID kategori' })
  @ApiResponse({ status: 200, description: 'Laporan pengeluaran per kategori berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format filter atau tanggal tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getCategories(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(reportFilterSchema)) query: ReportFilter,
  ): Promise<DashboardCategoryBreakdownResponse> {
    return this.dashboardService.getCategoryBreakdown(user.userId, query);
  }

  @Get('balance-changes')
  @ApiOperation({
    summary: 'Mendapatkan laporan perubahan saldo per akun',
    description:
      'FR-REPORTS-004. Perubahan saldo per akun (opening, inflow, outflow, closing) dalam periode yang dipilih.',
  })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'account_id', required: false, type: [String], description: 'Filter UUID akun' })
  @ApiResponse({ status: 200, description: 'Laporan perubahan saldo berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format filter atau tanggal tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getBalanceChanges(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(reportFilterSchema)) query: ReportFilter,
  ): Promise<BalanceChangesResponse> {
    return this.reportsService.getBalanceChanges(user.userId, query);
  }

  @Get('monthly-comparison')
  @ApiOperation({
    summary: 'Mendapatkan laporan perbandingan bulanan',
    description:
      'FR-REPORTS-006. Perbandingan performa keuangan bulan ini vs bulan sebelumnya, termasuk delta basis points (bp) dan breakdown per kategori.',
  })
  @ApiQuery({ name: 'month', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiResponse({ status: 200, description: 'Laporan perbandingan bulanan berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format bulan tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getMonthlyComparison(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(monthlyComparisonQuerySchema)) query: MonthlyComparisonQueryDto,
  ): Promise<MonthlyComparisonResponse> {
    return this.reportsService.getMonthlyComparison(user.userId, query.month);
  }
}
