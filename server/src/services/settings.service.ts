import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppSettings, AppSettingsRepository } from 'src/repositories/app-settings.repository';

/**
 * Operator-editable application settings, persisted in the `app_settings`
 * single-row table. Wraps the repository with typed getters so callers
 * (invoice composer, expense pipeline, settings controller) don't have to
 * know the storage shape.
 *
 * Initialization: at app boot, if the table is empty we seed a row with
 * placeholder values. The operator then fills the real values in via
 * /settings — there's no env-var pre-seeding because everything in this
 * table is UI config, not deploy-time secrets/config.
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
    const seeded = await this.repository.create({
      issuerKvk: 'CONFIGURE',
      issuerVatId: 'CONFIGURE',
      issuerAddressLine1: 'CONFIGURE',
      issuerPostalCode: 'CONFIGURE',
      issuerCity: 'CONFIGURE',
      issuerCountry: 'CONFIGURE',
      issuerIban: 'CONFIGURE',
      paperlessExpenseTags: ['Business', 'Bills'],
      paperlessOutgoingInvoiceTags: ['Business', 'Invoice', 'bo0kkeeper'],
    });
    this.logger.log('Seeded empty app_settings row — configure via /settings before first use');
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
