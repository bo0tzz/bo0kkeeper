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

const IntegrationCheckSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['healthy', 'degraded', 'broken', 'not_configured']),
  configured: z.boolean(),
  lastActivityAt: z.iso.datetime().nullable(),
  message: z.string(),
});

const IntegrationsResponseSchema = z
  .object({
    checks: z.array(IntegrationCheckSchema),
  })
  .meta({ id: 'IntegrationsResponseDto' });
export class IntegrationsResponseDto extends createZodDto(IntegrationsResponseSchema) {}

const SheetWriteStatusSchema = z
  .object({
    /**
     * Entities that should have a sheet row but don't, and have been in that
     * state for longer than the retry-job healing window. Non-zero means the
     * retry loop can't recover on its own — operator should investigate.
     */
    staleCount: z.number().int().min(0),
  })
  .meta({ id: 'SheetWriteStatusDto' });
export class SheetWriteStatusDto extends createZodDto(SheetWriteStatusSchema) {}
