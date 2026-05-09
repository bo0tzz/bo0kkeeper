import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { loadConfig } from 'src/config';
import { Authenticated } from 'src/decorators';
import { IntegrationsResponseDto, SystemInfoDto } from 'src/dtos/system.dto';
import { SystemHealthService } from 'src/services/system-health.service';

/**
 * Runtime invariants the UI needs to know about — env-sourced bits that
 * aren't user-editable. Exposes the active cutover date for dashboard
 * banners + per-integration health for the /system page.
 */
@ApiTags('System')
@Controller('/api/system')
export class SystemController {
  constructor(private readonly systemHealthService: SystemHealthService) {}

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
}
