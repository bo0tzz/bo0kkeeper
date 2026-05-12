import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { loadConfig } from 'src/config';
import { Authenticated } from 'src/decorators';
import { IntegrationsResponseDto, SystemInfoDto } from 'src/dtos/system.dto';
import { JobName } from 'src/enum';
import { JobRepository } from 'src/repositories/job.repository';
import { SystemHealthService } from 'src/services/system-health.service';

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
  ) {}

  @Get('info')
  @Authenticated()
  getInfo(): SystemInfoDto {
    const cutoverDate = loadConfig().cutoverDate ?? null;
    return {
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
}
