import { Controller, Get, Query, UseGuards, Res, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
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
  exportTransactionsCsvQuerySchema,
  type MonthlyComparisonQueryDto,
  type ExportTransactionsCsvQueryDto,
  type BalanceChangesResponse,
  type MonthlyComparisonResponse,
} from './dto/reports.dto.js';

@ApiTags('reports')
@ApiCookieAuth('__Host-duitku_session')
@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  private readonly logger = new Logger(ReportsController.name);

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
  @ApiQuery({ name: 'month', required: false, type: String, description: 'YYYY-MM (default bulan berjalan di timezone user)' })
  @ApiResponse({ status: 200, description: 'Laporan perbandingan bulanan berhasil diambil' })
  @ApiResponse({ status: 400, description: 'Format bulan tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async getMonthlyComparison(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(monthlyComparisonQuerySchema)) query: MonthlyComparisonQueryDto,
  ): Promise<MonthlyComparisonResponse> {
    return this.reportsService.getMonthlyComparison(user.userId, query.month);
  }

  @Get('export.csv')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Ekspor riwayat transaksi ke format CSV',
    description:
      'FR-REPORTS-008. Streaming ekspor riwayat transaksi ber-BOM UTF-8 dengan pembatasan rate limit 10 request/menit.',
  })
  @ApiQuery({ name: 'date_from', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'date_to', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'type', required: false, type: [String], description: 'Filter tipe transaksi' })
  @ApiQuery({ name: 'status', required: false, type: [String], description: 'Filter status transaksi' })
  @ApiQuery({ name: 'account_id', required: false, type: [String], description: 'Filter UUID akun' })
  @ApiQuery({ name: 'category_id', required: false, type: [String], description: 'Filter UUID kategori' })
  @ApiResponse({ status: 200, description: 'File CSV berhasil diunduh' })
  @ApiResponse({ status: 400, description: 'Parameter query tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 429, description: 'Rate limit ekspor CSV terlampaui' })
  async exportCsv(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(exportTransactionsCsvQuerySchema))
    query: ExportTransactionsCsvQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="duitku-transaksi.csv"',
    );

    try {
      await this.reportsService.streamTransactionsCsv(
        user.userId,
        query,
        (chunk: string) => {
          res.write(chunk);
        },
      );
      res.end();
    } catch (err: unknown) {
      this.logger.error('Error streaming CSV export', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.destroy();
    }
  }

  @Get('export.pdf')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Ekspor laporan keuangan ke format PDF',
    description:
      'FR-REPORTS-009. Ekspor laporan keuangan berformat PDF A4 via Puppeteer headless browser.',
  })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'account_id', required: false, type: [String], description: 'Filter UUID akun' })
  @ApiQuery({ name: 'category_id', required: false, type: [String], description: 'Filter UUID kategori' })
  @ApiResponse({ status: 200, description: 'File PDF berhasil diunduh' })
  @ApiResponse({ status: 400, description: 'Parameter filter tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 429, description: 'Rate limit ekspor PDF terlampaui' })
  @ApiResponse({ status: 503, description: 'Chromium gagal membuat PDF' })
  async exportPdf(
    @CurrentUser() user: { userId: string },
    @Query(new ZodValidationPipe(reportFilterSchema)) query: ReportFilter,
    @Res() res: Response,
  ): Promise<void> {
    const pdfBuffer = await this.reportsService.buildPdf(user.userId, query);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="duitku-laporan.pdf"',
    );
    res.send(pdfBuffer);
  }
}
