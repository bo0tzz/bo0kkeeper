import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { EventSource, ExpenseLocationClass, JobName, QueueName } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository, NewExpense } from 'src/repositories/expense.repository';
import { PaperlessService } from 'src/services/paperless.service';
import { SettingsService } from 'src/services/settings.service';
import { JobOf } from 'src/types';

/**
 * Consumes paperless `document.consumed` events and creates `pending_review`
 * expense rows. OCR-extracted fields land where paperless reliably surfaces
 * them (vendor from correspondent, date from `created`); amount and BTW
 * are left for the user to fill in during review — paperless's OCR isn't
 * trustworthy for BTW splits (the docs/decisions log spells out why).
 */
@Injectable()
export class ExpensePipelineService {
  private readonly logger = new Logger(ExpensePipelineService.name);

  constructor(
    private readonly eventRepository: EventRepository,
    private readonly expenseRepository: ExpenseRepository,
    private readonly paperlessService: PaperlessService,
    private readonly settingsService: SettingsService,
  ) {}

  @OnJob({ name: JobName.ProcessPaperlessDocument, queue: QueueName.Webhook })
  async handleProcessPaperlessDocument({ eventId }: JobOf<JobName.ProcessPaperlessDocument>): Promise<void> {
    const event = await this.eventRepository.findById(eventId);
    if (!event) {
      throw new NotFoundException(`Event not found: ${eventId}`);
    }
    if (event.source !== EventSource.Paperless) {
      this.logger.warn(`Skipping non-paperless event on ProcessPaperlessDocument: ${event.source}/${event.eventType}`);
      await this.eventRepository.markProcessed(event.id);
      return;
    }

    const parsed = parsePaperlessPayload(event.payload);
    if (!parsed) {
      this.logger.warn(`Paperless payload had no document_id; skipping event ${event.id}`);
      await this.eventRepository.markProcessed(event.id);
      return;
    }

    // Tag gate: the workflow webhook fires for every consumed document, but
    // only docs tagged with the configured expense tags should land in the
    // bookkeeper queue. Re-fetch the doc from paperless API rather than
    // trusting the webhook payload (workflow templates are unreliable).
    const expenseTags = await this.settingsService.getPaperlessExpenseTags();
    if (expenseTags.length > 0) {
      try {
        const requiredIds = await this.paperlessService.resolveTagIds(expenseTags, { createMissing: false });
        const doc = await this.paperlessService.getDocument(parsed.documentId);
        const docTags = new Set(doc.tags);
        const missing = requiredIds.filter((id) => !docTags.has(id));
        if (missing.length > 0) {
          this.logger.log(
            `Skipping paperless ${parsed.documentId} (tags ${[...doc.tags].join(',')} missing required ${expenseTags.join(',')})`,
          );
          await this.eventRepository.markProcessed(event.id);
          return;
        }
      } catch (error) {
        // If we can't resolve tags or fetch the doc, fall through to ingestion
        // rather than dropping the event silently — the user can review in the
        // queue and we'd rather over-ingest than under-ingest.
        this.logger.warn(`Tag-gate check failed for paperless ${parsed.documentId}: ${(error as Error).message}`);
      }
    }

    const newExpense: NewExpense = {
      paperlessDocId: parsed.documentId,
      vendor: parsed.vendor ?? '',
      expenseDate: parsed.expenseDate ?? new Date(),
      amountMinor: 0n,
      currency: 'EUR',
      btwRateBps: null,
      btwMinor: null,
      locationClass: parsed.locationClassGuess,
      category: '',
      notes: null,
      sourceEventId: event.id,
    };
    const result = await this.expenseRepository.ingest(newExpense);
    if (result.ingested) {
      this.logger.log(`expense pending_review created from paperless ${parsed.documentId} (event ${event.id})`);
    } else {
      this.logger.log(`paperless ${parsed.documentId} already has expense ${result.existingId}`);
    }
    await this.eventRepository.markProcessed(event.id);
  }
}

type ParsedPaperless = {
  documentId: string;
  vendor: string | null;
  expenseDate: Date | null;
  locationClassGuess: ExpenseLocationClass;
};

function parsePaperlessPayload(payload: Record<string, unknown>): ParsedPaperless | null {
  const documentId = pickStringOrNumber(payload, ['document_id', 'id']);
  if (documentId === null) {
    return null;
  }
  const vendor = pickString(payload, ['correspondent', 'correspondent_name']);
  const created = pickString(payload, ['created', 'created_date']);
  return {
    documentId: String(documentId),
    vendor,
    expenseDate: created ? new Date(created) : null,
    locationClassGuess: ExpenseLocationClass.Domestic,
  };
}

function pickStringOrNumber(payload: Record<string, unknown>, keys: string[]): string | number | null {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === 'string' || typeof v === 'number') {
      return v;
    }
  }
  return null;
}

function pickString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) {
      return v;
    }
  }
  return null;
}
