import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppSettings, AppSettingsRepository } from 'src/repositories/app-settings.repository';

function splitTags(raw: string | undefined, fallback: string): string[] {
  return (raw ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Operator-editable application settings, persisted in the `app_settings`
 * single-row table. Wraps the repository with typed getters so callers
 * (invoice composer, expense pipeline, settings controller) don't have to
 * know the storage shape.
 *
 * Initialization: at app boot, if the table is empty (fresh install or
 * post-migration first run), we seed the row from the current process
 * env using the historical config defaults. After that, env is no longer
 * consulted — the operator edits via /settings and the row is the truth.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly repository: AppSettingsRepository) {}

  async onModuleInit(): Promise<void> {
    await this.ensureInitialized();
  }

  private async ensureInitialized(): Promise<AppSettings> {
    const existing = await this.repository.findOne();
    if (existing) {
      return existing;
    }
    const env = process.env;
    const seeded = await this.repository.create({
      issuerKvk: env.ISSUER_KVK ?? 'CONFIGURE',
      issuerVatId: env.ISSUER_VAT_ID ?? 'CONFIGURE',
      issuerAddressLine1: env.ISSUER_ADDRESS_LINE1 ?? 'CONFIGURE',
      issuerPostalCode: env.ISSUER_POSTAL_CODE ?? 'CONFIGURE',
      issuerCity: env.ISSUER_CITY ?? 'CONFIGURE',
      issuerCountry: env.ISSUER_COUNTRY ?? 'CONFIGURE',
      issuerIban: env.ISSUER_IBAN ?? 'CONFIGURE',
      paperlessExpenseTags: splitTags(env.PAPERLESS_EXPENSE_TAGS, 'Business,Bills'),
      paperlessOutgoingInvoiceTags: splitTags(env.PAPERLESS_OUTGOING_INVOICE_TAGS, 'Business,Invoice,bo0kkeeper'),
    });
    this.logger.log('Seeded app_settings row from environment defaults');
    return seeded;
  }

  /** Read-through getter — caller waits one query, but always sees fresh state. */
  async get(): Promise<AppSettings> {
    const existing = await this.repository.findOne();
    if (existing) {
      return existing;
    }
    return this.ensureInitialized();
  }

  /** Issuer info (KvK, VAT id, address, IBAN) — printed on every invoice. */
  async getIssuer(): Promise<{
    kvk: string;
    vatId: string;
    addressLine1: string;
    postalCode: string;
    city: string;
    country: string;
    iban: string;
  }> {
    const s = await this.get();
    return {
      kvk: s.issuerKvk,
      vatId: s.issuerVatId,
      addressLine1: s.issuerAddressLine1,
      postalCode: s.issuerPostalCode,
      city: s.issuerCity,
      country: s.issuerCountry,
      iban: s.issuerIban,
    };
  }

  async getPaperlessExpenseTags(): Promise<string[]> {
    const s = await this.get();
    return s.paperlessExpenseTags;
  }

  async getPaperlessOutgoingInvoiceTags(): Promise<string[]> {
    const s = await this.get();
    return s.paperlessOutgoingInvoiceTags;
  }

  async update(
    patch: Partial<{
      issuerKvk: string;
      issuerVatId: string;
      issuerAddressLine1: string;
      issuerPostalCode: string;
      issuerCity: string;
      issuerCountry: string;
      issuerIban: string;
      paperlessExpenseTags: string[];
      paperlessOutgoingInvoiceTags: string[];
    }>,
  ): Promise<AppSettings> {
    const current = await this.get();
    return this.repository.update(current.id, patch);
  }
}
