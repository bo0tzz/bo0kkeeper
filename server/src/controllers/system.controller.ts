import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { loadConfig } from 'src/config';
import { APP_VERSION } from 'src/constants';
import { Authenticated } from 'src/decorators';
import { IntegrationsResponseDto, SheetWriteStatusDto, SystemInfoDto } from 'src/dtos/system.dto';
import { JobName } from 'src/enum';
import { BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { ExpenseRepository } from 'src/repositories/expense.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { SystemHealthService } from 'src/services/system-health.service';

/** Treat a missing sheet row as "stale" if it's been pending longer than this. */
const SHEET_WRITE_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Runtime invariants the UI needs to know about — env-sourced bits that
 * aren't user-editable. Exposes the active cutover date for dashboard
 * banners + per-integration health for the /system page.
 */
@ApiTags('System')
@Controller('/api/system')
export class SystemController {
  constructor(
    private readonly systemHealthService: SystemHealthService,
    private readonly jobRepository: JobRepository,
    private readonly bankTransactionRepository: BankTransactionRepository,
    private readonly expenseRepository: ExpenseRepository,
  ) {}

  @Get('info')
  @Authenticated()
  getInfo(): SystemInfoDto {
    const cutoverDate = loadConfig().cutoverDate ?? null;
    return {
      version: APP_VERSION,
      cutoverDate,
      ingestionEnabled: cutoverDate !== null,
    };
  }

  @Get('integrations')
  @Authenticated()
  async getIntegrations(): Promise<IntegrationsResponseDto> {
    const checks = await this.systemHealthService.checkAll();
    return { checks };
  }

  /**
   * Trigger an immediate sheet-write retry — re-attempts any matched
   * bank_tx / approved expense whose sheet row failed to land. Same job
   * pg-boss runs hourly; this is the "do it now" button from the
   * dashboard's Sheet-write-failures tile.
   */
  @Post('retry-sheet-writes')
  @Authenticated()
  async retrySheetWrites(): Promise<{ enqueued: true }> {
    await this.jobRepository.queue(JobName.SheetWriteRetry, {});
    return { enqueued: true };
  }

  /**
   * Current sheet-write health — counts entities that should have a sheet
   * row but don't and have been waiting longer than the retry-job healing
   * window. Distinct from the `sheet.write_failed` event count, which is
   * historical noise that doesn't tell you whether the system has actually
   * recovered.
   */
  @Get('sheet-write-status')
  @Authenticated()
  async getSheetWriteStatus(): Promise<SheetWriteStatusDto> {
    const [bankTxStale, expenseStale] = await Promise.all([
      this.bankTransactionRepository.countStaleSheetWrites(SHEET_WRITE_STALE_AFTER_MS),
      this.expenseRepository.countStaleSheetWrites(SHEET_WRITE_STALE_AFTER_MS),
    ]);
    return { staleCount: bankTxStale + expenseStale };
  }
}
