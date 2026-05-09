import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Authenticated } from 'src/decorators';
import {
  PaperlessTagCheckDto,
  PaperlessTagCheckResponseDto,
  SettingsResponseDto,
  UpdateSettingsDto,
} from 'src/dtos/settings.dto';
import { EventSource } from 'src/enum';
import { AppSettings } from 'src/repositories/app-settings.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { PaperlessService } from 'src/services/paperless.service';
import { SettingsService } from 'src/services/settings.service';

/**
 * Read + write the operator-editable application settings (issuer info +
 * paperless tag names). Secrets, infra, and init-once values stay in env
 * and aren't surfaced here at all.
 */
@ApiTags('Settings')
@Controller('/api/settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly eventRepository: EventRepository,
    private readonly paperlessService: PaperlessService,
  ) {}

  @Get()
  @Authenticated()
  async get(): Promise<SettingsResponseDto> {
    const settings = await this.settingsService.get();
    return toDto(settings);
  }

  /**
   * Partial update — any subset of issuer fields and/or paperless tag
   * arrays. Empty arrays disable the corresponding tag-gate / tagging path.
   */
  @Patch()
  @Authenticated()
  async update(@Body() body: UpdateSettingsDto): Promise<SettingsResponseDto> {
    const patch: Parameters<SettingsService['update']>[0] = {};
    if (body.issuer) {
      if (body.issuer.kvk !== undefined) {
        patch.issuerKvk = body.issuer.kvk;
      }
      if (body.issuer.vatId !== undefined) {
        patch.issuerVatId = body.issuer.vatId;
      }
      if (body.issuer.addressLine1 !== undefined) {
        patch.issuerAddressLine1 = body.issuer.addressLine1;
      }
      if (body.issuer.postalCode !== undefined) {
        patch.issuerPostalCode = body.issuer.postalCode;
      }
      if (body.issuer.city !== undefined) {
        patch.issuerCity = body.issuer.city;
      }
      if (body.issuer.country !== undefined) {
        patch.issuerCountry = body.issuer.country;
      }
      if (body.issuer.iban !== undefined) {
        patch.issuerIban = body.issuer.iban;
      }
    }
    if (body.paperless) {
      if (body.paperless.expenseTags !== undefined) {
        patch.paperlessExpenseTags = body.paperless.expenseTags;
      }
      if (body.paperless.outgoingInvoiceTags !== undefined) {
        patch.paperlessOutgoingInvoiceTags = body.paperless.outgoingInvoiceTags;
      }
    }
    const updated = await this.settingsService.update(patch);
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'settings.updated',
      payload: { keys: Object.keys(patch) },
    });
    return toDto(updated);
  }

  /**
   * Read-only existence check against the live paperless tag set. Lets the
   * operator verify they typed the gate names correctly before saving — a
   * typo in `paperlessExpenseTags` silently breaks the expense pipeline
   * (tag-gate falls open and ingests every doc, or fails-and-warns on
   * every webhook depending on env). Does not create tags.
   */
  @Post('/paperless/tag-check')
  @Authenticated()
  async checkPaperlessTags(@Body() body: PaperlessTagCheckDto): Promise<PaperlessTagCheckResponseDto> {
    const results = await this.paperlessService.checkTagsExist(body.tags);
    return { results };
  }
}

function toDto(s: AppSettings): SettingsResponseDto {
  return {
    issuer: {
      kvk: s.issuerKvk,
      vatId: s.issuerVatId,
      addressLine1: s.issuerAddressLine1,
      postalCode: s.issuerPostalCode,
      city: s.issuerCity,
      country: s.issuerCountry,
      iban: s.issuerIban,
    },
    paperless: {
      expenseTags: s.paperlessExpenseTags,
      outgoingInvoiceTags: s.paperlessOutgoingInvoiceTags,
    },
    updatedAt: new Date(s.updatedAt).toISOString(),
  };
}
