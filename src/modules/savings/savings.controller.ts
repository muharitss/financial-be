import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
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
  ApiCookieAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  SavingsService,
  SavingsGoalResponse,
  AllocateGoalResponse,
  ReleaseAllocationResponse,
  GoalDetailResponse,
} from './savings.service.js';
import {
  createSavingsGoalSchema,
  updateSavingsGoalSchema,
  createAllocationSchema,
  releaseAllocationSchema,
  type CreateSavingsGoalDto,
  type UpdateSavingsGoalDto,
  type CreateAllocationDto,
  type ReleaseAllocationDto,
} from './dto/savings.dto.js';

@ApiTags('savings')
@ApiCookieAuth('__Host-duitku_session')
@Controller('savings/goals')
@UseGuards(JwtAuthGuard)
export class SavingsController {
  constructor(private readonly savingsService: SavingsService) {}

  @Get()
  @ApiOperation({ summary: 'Mendapatkan daftar target tabungan' })
  @ApiQuery({ name: 'include_archived', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Daftar target tabungan berhasil diambil' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async list(
    @CurrentUser() user: { userId: string; role?: string },
    @Query('include_archived') includeArchived?: string,
  ): Promise<SavingsGoalResponse[]> {
    return this.savingsService.listGoals(user.userId, includeArchived === 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Mendapatkan detail target tabungan dan riwayat alokasi' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'ID target tabungan' })
  @ApiResponse({ status: 200, description: 'Detail target tabungan berhasil diambil' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Target tabungan tidak ditemukan' })
  async detail(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<GoalDetailResponse> {
    return this.savingsService.getGoalDetail(user.userId, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Membuat target tabungan baru' })
  @ApiResponse({ status: 201, description: 'Target tabungan berhasil dibuat' })
  @ApiResponse({ status: 400, description: 'Data tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  async create(
    @CurrentUser() user: { userId: string; role?: string },
    @Body(new ZodValidationPipe(createSavingsGoalSchema)) dto: CreateSavingsGoalDto,
  ): Promise<SavingsGoalResponse> {
    return this.savingsService.createGoal(user, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Memperbarui target tabungan' })
  @ApiResponse({ status: 200, description: 'Target tabungan berhasil diperbarui' })
  @ApiResponse({ status: 400, description: 'Data tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Target tabungan tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Target tabungan sudah diarsipkan' })
  async update(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateSavingsGoalSchema)) dto: UpdateSavingsGoalDto,
  ): Promise<SavingsGoalResponse> {
    return this.savingsService.updateGoal(user, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mengarsipkan target tabungan' })
  @ApiResponse({ status: 200, description: 'Target tabungan berhasil diarsipkan' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Target tabungan tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Target tabungan memiliki alokasi aktif' })
  async archive(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SavingsGoalResponse> {
    return this.savingsService.archiveGoal(user, id);
  }

  @Post(':id/allocations')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Mengalokasikan dana dari akun ke target tabungan' })
  @ApiResponse({ status: 201, description: 'Alokasi berhasil dibuat' })
  @ApiResponse({ status: 400, description: 'Data tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Target tabungan atau akun tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Saldo tidak mencukupi atau target/akun diarsipkan' })
  @ApiResponse({ status: 422, description: 'Tipe akun tidak dapat dialokasikan' })
  async allocate(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(createAllocationSchema)) dto: CreateAllocationDto,
  ): Promise<AllocateGoalResponse> {
    return this.savingsService.allocate(user, id, dto);
  }

  @Post(':id/allocations/:allocationId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Melepaskan alokasi dana dari target tabungan' })
  @ApiResponse({ status: 200, description: 'Alokasi berhasil dilepaskan' })
  @ApiResponse({ status: 400, description: 'Data tidak valid' })
  @ApiResponse({ status: 401, description: 'Sesi tidak valid' })
  @ApiResponse({ status: 404, description: 'Target tabungan atau alokasi tidak ditemukan' })
  @ApiResponse({ status: 409, description: 'Alokasi tabungan sudah dilepaskan sebelumnya' })
  async releaseAllocation(
    @CurrentUser() user: { userId: string; role?: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('allocationId', new ParseUUIDPipe()) allocationId: string,
    @Body(new ZodValidationPipe(releaseAllocationSchema)) dto: ReleaseAllocationDto,
  ): Promise<ReleaseAllocationResponse> {
    return this.savingsService.releaseAllocation(user, id, allocationId, dto);
  }
}
