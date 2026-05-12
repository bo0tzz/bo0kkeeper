import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';

/**
 * Liveness + readiness probes. Both intentionally unauthenticated so
 * orchestrators (Docker HEALTHCHECK, k8s kubelet) can hit them without
 * holding an OIDC session.
 *
 * Semantics:
 *   - `GET /api/health` — liveness: process is up. Always 200 unless the
 *     event loop is wedged enough that it can't respond at all, in which
 *     case k8s will restart the pod.
 *   - `GET /api/health/ready` — readiness: pod can actually serve traffic.
 *     Pings the database, since every domain endpoint depends on it.
 *     Returns 503 with `{status: 'not_ready', reason}` if the ping fails
 *     so k8s drops the pod from the Service rotation without restarting.
 *
 * Deliberately does NOT check external integrations (Sheets, Wise,
 * Paperless, Enable Banking). Those have their own retry/audit machinery
 * and a transient outage on any of them shouldn't depool the pod —
 * `/api/system/integrations` is the surface for that.
 */
@ApiTags('Health')
@Controller('/api/health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  @Get()
  getHealth() {
    return { status: 'ok' };
  }

  @Get('ready')
  async getReady(): Promise<{ status: 'ok' }> {
    try {
      await sql`SELECT 1`.execute(this.db);
      return { status: 'ok' };
    } catch (error) {
      const reason = (error as Error).message;
      this.logger.warn(`readiness probe failed: ${reason}`);
      throw new ServiceUnavailableException({ status: 'not_ready', reason });
    }
  }
}
