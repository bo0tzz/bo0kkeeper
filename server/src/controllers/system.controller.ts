import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { loadConfig } from 'src/config';
import { Authenticated } from 'src/decorators';
import { SystemInfoDto } from 'src/dtos/system.dto';

/**
 * Runtime invariants the UI needs to know about — env-sourced bits that
 * aren't user-editable. Currently exposes the active cutover date so the
 * dashboard can warn loudly when ingestion is disabled.
 */
@ApiTags('System')
@Controller('/api/system')
export class SystemController {
  @Get('info')
  @Authenticated()
  getInfo(): SystemInfoDto {
    const cutoverDate = loadConfig().cutoverDate ?? null;
    return {
      cutoverDate,
      ingestionEnabled: cutoverDate !== null,
    };
  }
}
