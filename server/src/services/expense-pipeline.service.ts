import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { EventSource, ExpenseLocationClass, JobName, QueueName } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository, NewExpense } from 'src/repositories/expense.repository';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { SettingsService } from 'src/services/settings.service';
import { JobOf } from 'src/types';
import { PaperlessPayload, readPaperlessEventPayload, resolvePaperlessDocId } from 'src/utils/paperless-payload';

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
    private readonly invoiceRepository: InvoiceRepository,
    private readonly paperlessService: PaperlessRepository,
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

    const payload = readPaperlessEventPayload(event);
    const parsed = parsePaperlessPayload(payload);
    if (!parsed) {
      this.logger.warn(`Paperless payload had no document_id; skipping event ${event.id}`);
      await this.eventRepository.markProcessed(event.id);
      return;
    }

    // Outgoing-invoice guard: if this paperless doc is one bo0kkeeper itself
    // uploaded (the archive job persists paperlessDocId on the invoice row),
    // it's an outbound invoice — never an inbound expense. Catches both the
    // backfill path (rescan-paperless pulling our own docs in) and any
    // misconfigured tag gate that lets our invoice tags match the expense
    // gate. Robust regardless of how the user configures Settings tags.
    const linkedInvoice = await this.invoiceRepository.findByPaperlessDocId(parsed.documentId);
    if (linkedInvoice) {
      this.logger.log(
        `Skipping paperless ${parsed.documentId} — already linked to invoice ${linkedInvoice.number} (one of ours)`,
      );
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

function parsePaperlessPayload(payload: PaperlessPayload): ParsedPaperless | null {
  const documentId = resolvePaperlessDocId(payload);
  if (documentId === undefined) {
    return null;
  }
  const vendor = payload.correspondent?.length ? payload.correspondent : (payload.correspondent_name ?? null);
  const created = payload.created?.length ? payload.created : payload.created_date;
  return {
    documentId,
    vendor: vendor ?? null,
    expenseDate: created ? new Date(created) : null,
    locationClassGuess: ExpenseLocationClass.Domestic,
  };
}
