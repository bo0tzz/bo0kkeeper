import { Injectable, Logger } from '@nestjs/common';
import { loadConfig } from 'src/config';
import { EventSource } from 'src/enum';
import { BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { PaperlessService } from 'src/services/paperless.service';
import { SettingsService } from 'src/services/settings.service';
import { WiseApiService } from 'src/services/wise-api.service';

export type IntegrationStatus = 'healthy' | 'degraded' | 'broken' | 'not_configured';

export type IntegrationCheck = {
  /** Stable id (e.g. `wise`, `paperless`). */
  id: string;
  /** Display label. */
  name: string;
  status: IntegrationStatus;
  configured: boolean;
  /** ISO datetime of the most recent activity, when applicable. Null otherwise. */
  lastActivityAt: string | null;
  /** One-line operator-facing message. */
  message: string;
};

const PING_TIMEOUT_MS = 5000;

/**
 * Aggregates per-integration health checks for the operator dashboard.
 * Each check is independent + best-effort — a slow or broken integration
 * doesn't block the others. Live API pings are wrapped in a timeout so
 * the page always returns within a few seconds.
 */
@Injectable()
export class SystemHealthService {
  private readonly logger = new Logger(SystemHealthService.name);

  constructor(
    private readonly eventRepository: EventRepository,
    private readonly bankingSessionRepository: BankingSessionRepository,
    private readonly paperlessService: PaperlessService,
    private readonly settingsService: SettingsService,
    private readonly wiseApiService: WiseApiService,
  ) {}

  async checkAll(): Promise<IntegrationCheck[]> {
    return Promise.all([
      Promise.resolve(this.checkCutover()),
      this.checkWise(),
      this.checkPaperless(),
      this.checkEnableBanking(),
      Promise.resolve(this.checkSheets()),
      Promise.resolve(this.checkOidc()),
    ]);
  }

  private checkCutover(): IntegrationCheck {
    const cutover = loadConfig().cutoverDate;
    if (!cutover) {
      return {
        id: 'cutover',
        name: 'Cutover',
        status: 'not_configured',
        configured: false,
        lastActivityAt: null,
        message: 'CUTOVER_DATE unset — every ingest path drops everything.',
      };
    }
    return {
      id: 'cutover',
      name: 'Cutover',
      status: 'healthy',
      configured: true,
      lastActivityAt: null,
      message: `Ingestion floor: ${cutover}`,
    };
  }

  private async checkWise(): Promise<IntegrationCheck> {
    const cfg = loadConfig().wise;
    const lastEvent = await this.lastEventAt(EventSource.Wise);
    const configured = Boolean(cfg.apiToken && cfg.profileId !== undefined);
    if (!configured) {
      return {
        id: 'wise',
        name: 'Wise',
        status: 'not_configured',
        configured: false,
        lastActivityAt: lastEvent,
        message: 'WISE_API_TOKEN or WISE_PROFILE_ID unset — drafting disabled.',
      };
    }
    try {
      await withTimeout(this.wiseApiService.ping(), PING_TIMEOUT_MS);
      return {
        id: 'wise',
        name: 'Wise',
        status: 'healthy',
        configured: true,
        lastActivityAt: lastEvent,
        message: 'Profile lookup succeeded.',
      };
    } catch (error) {
      return {
        id: 'wise',
        name: 'Wise',
        status: 'broken',
        configured: true,
        lastActivityAt: lastEvent,
        message: `Profile lookup failed: ${(error as Error).message}`,
      };
    }
  }

  private async checkPaperless(): Promise<IntegrationCheck> {
    const cfg = loadConfig().paperless;
    const lastEvent = await this.lastEventAt(EventSource.Paperless);
    const configured = Boolean(cfg.baseUrl && cfg.token);
    if (!configured) {
      return {
        id: 'paperless',
        name: 'Paperless',
        status: 'not_configured',
        configured: false,
        lastActivityAt: lastEvent,
        message: 'PAPERLESS_BASE_URL or PAPERLESS_TOKEN unset.',
      };
    }
    try {
      const tags = await this.settingsService.getPaperlessExpenseTags();
      if (tags.length === 0) {
        return {
          id: 'paperless',
          name: 'Paperless',
          status: 'degraded',
          configured: true,
          lastActivityAt: lastEvent,
          message: 'Reachable, but no expense tag-gate configured (every tagged doc would ingest).',
        };
      }
      const checked = await withTimeout(this.paperlessService.checkTagsExist(tags), PING_TIMEOUT_MS);
      const missing = checked.filter((c) => !c.exists);
      if (missing.length > 0) {
        return {
          id: 'paperless',
          name: 'Paperless',
          status: 'degraded',
          configured: true,
          lastActivityAt: lastEvent,
          message: `Reachable, but tag(s) missing in paperless: ${missing.map((m) => m.name).join(', ')}.`,
        };
      }
      return {
        id: 'paperless',
        name: 'Paperless',
        status: 'healthy',
        configured: true,
        lastActivityAt: lastEvent,
        message: `${tags.length} tag${tags.length === 1 ? '' : 's'} verified.`,
      };
    } catch (error) {
      return {
        id: 'paperless',
        name: 'Paperless',
        status: 'broken',
        configured: true,
        lastActivityAt: lastEvent,
        message: `Tag lookup failed: ${(error as Error).message}`,
      };
    }
  }

  private async checkEnableBanking(): Promise<IntegrationCheck> {
    const cfg = loadConfig().enableBanking;
    const configured = Boolean(cfg.appId && cfg.privateKey && cfg.redirectUri);
    if (!configured) {
      return {
        id: 'enable_banking',
        name: 'Enable Banking',
        status: 'not_configured',
        configured: false,
        lastActivityAt: null,
        message: 'ENABLE_BANKING_APP_ID / PRIVATE_KEY / REDIRECT_URI unset.',
      };
    }
    const session = await this.bankingSessionRepository.findLatest();
    if (!session) {
      return {
        id: 'enable_banking',
        name: 'Enable Banking',
        status: 'degraded',
        configured: true,
        lastActivityAt: null,
        message: 'Configured, but no consent session yet — open /banking to connect.',
      };
    }
    const lastSync = session.lastSyncedAt instanceof Date ? session.lastSyncedAt.toISOString() : null;
    if (session.status === 'expired' || session.status === 'revoked') {
      return {
        id: 'enable_banking',
        name: 'Enable Banking',
        status: 'broken',
        configured: true,
        lastActivityAt: lastSync,
        message: `Consent ${session.status} — reconnect at /banking.`,
      };
    }
    if (session.status === 'pending') {
      return {
        id: 'enable_banking',
        name: 'Enable Banking',
        status: 'degraded',
        configured: true,
        lastActivityAt: lastSync,
        message: 'Consent pending — finish the bank-side auth flow.',
      };
    }
    const expiresAt = session.expiresAt instanceof Date ? session.expiresAt : null;
    const daysLeft = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null;
    if (daysLeft !== null && daysLeft <= 7) {
      return {
        id: 'enable_banking',
        name: 'Enable Banking',
        status: 'degraded',
        configured: true,
        lastActivityAt: lastSync,
        message: `Consent expires in ${daysLeft}d — reconnect soon.`,
      };
    }
    return {
      id: 'enable_banking',
      name: 'Enable Banking',
      status: 'healthy',
      configured: true,
      lastActivityAt: lastSync,
      message: daysLeft === null ? 'Active consent.' : `Active; ${daysLeft}d until renewal.`,
    };
  }

  private checkSheets(): IntegrationCheck {
    const cfg = loadConfig().sheets;
    const configured = Boolean(cfg.serviceAccountEmail && cfg.serviceAccountPrivateKey && cfg.spreadsheetId);
    if (!configured) {
      return {
        id: 'sheets',
        name: 'Google Sheets',
        status: 'not_configured',
        configured: false,
        lastActivityAt: null,
        message: 'SHEETS_SERVICE_ACCOUNT_* / SPREADSHEET_ID unset.',
      };
    }
    // No live ping — Google's auth handshake is non-trivial and pinging on
    // every page load is expensive. Configured + format-valid is enough for
    // operator confidence; actual write failures show on the failed-events
    // surface.
    return {
      id: 'sheets',
      name: 'Google Sheets',
      status: 'healthy',
      configured: true,
      lastActivityAt: null,
      message: 'Service account + spreadsheet id configured.',
    };
  }

  private checkOidc(): IntegrationCheck {
    // OIDC is required at boot, so if we got here with a request making it past
    // the auth guard, the IDP discovery and JWKS are functional. Configured =
    // healthy by definition; surface for completeness.
    const cfg = loadConfig().oidc;
    return {
      id: 'oidc',
      name: 'OIDC',
      status: 'healthy',
      configured: true,
      lastActivityAt: null,
      message: `Issuer: ${cfg.issuer}`,
    };
  }

  /** Most recent receivedAt for any event from the given source, ISO. */
  private async lastEventAt(source: EventSource): Promise<string | null> {
    const page = await this.eventRepository.findMany({ source, limit: 1, offset: 0 });
    const first = page.items[0];
    if (!first) {
      return null;
    }
    return first.receivedAt instanceof Date ? first.receivedAt.toISOString() : String(first.receivedAt);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms).unref(),
    ),
  ]);
}
