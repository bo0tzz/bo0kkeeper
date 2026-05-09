import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const SystemInfoSchema = z
  .object({
    /** Active CUTOVER_DATE if configured; null = ingestion disabled. */
    cutoverDate: z.iso.date().nullable(),
    /** Convenience boolean derived from cutoverDate, for UI banners. */
    ingestionEnabled: z.boolean(),
  })
  .meta({ id: 'SystemInfoDto' });
export class SystemInfoDto extends createZodDto(SystemInfoSchema) {}
