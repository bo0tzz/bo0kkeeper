import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createVerify, timingSafeEqual } from 'node:crypto';
import { loadConfig } from 'src/config';
import { PaperlessWebhookDto, WiseWebhookDto } from 'src/dtos/webhook.dto';
import { EventSource, JobName } from 'src/enum';
import { Event, EventRepository, NewEvent } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { checkCutover } from 'src/utils/cutover';

/**
 * Outcome of a webhook ingest attempt. Both webhook controllers respond
 * with `{ ingested }` to the external system regardless of which `false`
 * reason fired — duplicate retry, pre-cutover event, or no cutover
 * configured all want the same upstream behaviour: 200, don't retry. The
 * `reason` is logged for visibility.
 */
export type WebhookIngestResult =
  | { ingested: true; event: Event }
  | { ingested: false; reason: 'duplicate' | 'before_cutover' | 'no_cutover_configured' };

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly wiseConfig = loadConfig().wise;
  private readonly paperlessConfig = loadConfig().paperless;

  constructor(
    private readonly eventRepository: EventRepository,
    private readonly jobRepository: JobRepository,
  ) {}

  /**
   * Verify Wise's RSA-SHA256 signature over the raw request body. In dev mode
   * (`WISE_WEBHOOK_VERIFY=false`) the verification is skipped with a log line.
   */
  verifyWiseSignature(rawBody: string, signatureHeader?: string): void {
    if (!this.wiseConfig.verifySignatures) {
      this.logger.warn('Wise webhook signature verification is disabled (WISE_WEBHOOK_VERIFY=false)');
      return;
    }
    if (!this.wiseConfig.publicKey) {
      throw new Error('Wise signature verification enabled but WISE_WEBHOOK_PUBLIC_KEY is not set');
    }
    if (!signatureHeader) {
      throw new UnauthorizedException('Missing X-Signature-SHA256 header');
    }

    const verifier = createVerify('RSA-SHA256');
    verifier.update(rawBody);
    verifier.end();

    const ok = verifier.verify(this.wiseConfig.publicKey, signatureHeader, 'base64');
    if (!ok) {
      throw new UnauthorizedException('Invalid Wise webhook signature');
    }
  }

  /**
   * Build the events row for a Wise webhook payload and ingest idempotently.
   * On first sight, also enqueue any follow-up @OnJob handlers keyed off the
   * event type. Retries (duplicate ingests) don't re-enqueue.
   *
   * `externalId` priority: explicit X-Delivery-Id header → derived from
   * `subscription_id + sent_at + resource.id` → `subscription_id + event_type + sent_at`.
   * Whichever is unique enough to deduplicate retries.
   */
  async ingestWiseEvent(payload: WiseWebhookDto, deliveryId?: string): Promise<WebhookIngestResult> {
    const externalId = deliveryId ?? deriveWiseExternalId(payload);
    const occurredAt = payload.data.occurred_at ?? payload.sent_at ?? new Date().toISOString();
    const occurredDate = new Date(occurredAt);

    const decision = checkCutover(occurredDate);
    if (!decision.allowed) {
      this.logger.log(`wise event ${externalId} skipped: ${decision.reason}`);
      return { ingested: false, reason: decision.reason };
    }

    const event: NewEvent = {
      source: EventSource.Wise,
      eventType: payload.event_type,
      externalId,
      occurredAt: occurredDate,
      payload: payload as unknown as Record<string, unknown>,
      correlationId: deriveCorrelationId(payload),
    };

    const result = await this.eventRepository.ingest(event);

    if (result.ingested) {
      await this.enqueueFollowUp(payload.event_type, result.event.id);
      return { ingested: true, event: result.event };
    }
    return { ingested: false, reason: 'duplicate' };
  }

  private async enqueueFollowUp(eventType: string, eventId: string): Promise<void> {
    if (eventType === 'transfers#state-change') {
      await this.jobRepository.queue(JobName.WiseTransferStateChange, { eventId });
      return;
    }
    // `balances#credit` is intentionally not auto-enqueued: drafts need a TXN
    // reference and human review. The admin UI calls `/api/wise/draft-from-event`.
  }

  /**
   * Verify the shared bearer token configured for paperless-ngx workflow
   * webhooks. When `PAPERLESS_WEBHOOK_TOKEN` is unset, verification is skipped
   * with a log line — same dev-bypass shape as Wise.
   */
  verifyPaperlessAuthorization(authHeader?: string): void {
    const expected = this.paperlessConfig.webhookToken;
    if (!expected) {
      this.logger.warn('Paperless webhook authentication is disabled (PAPERLESS_WEBHOOK_TOKEN not set)');
      return;
    }
    const presented = authHeader?.replace(/^Bearer\s+/i, '').trim();
    if (!presented || !constantTimeEquals(presented, expected)) {
      throw new UnauthorizedException('Invalid Paperless webhook token');
    }
  }

  /**
   * Ingest a paperless `document.consumed` workflow webhook idempotently and
   * enqueue ProcessPaperlessDocument on first sight. The `externalId` is the
   * document id — paperless guarantees one consume callback per document.
   */
  async ingestPaperlessEvent(payload: PaperlessWebhookDto, deliveryId?: string): Promise<WebhookIngestResult> {
    const documentId = payload.document_id ?? payload.id ?? payload.doc_pk;
    if (documentId === undefined) {
      // Schema-level refine catches this; defensive guard for direct callers.
      throw new Error('paperless webhook body has no document id');
    }
    const occurredAt = payload.created ?? payload.created_date ?? new Date().toISOString();
    const externalId = deliveryId ?? `paperless:${documentId}`;
    const eventType = payload.event_type ?? 'document.consumed';

    const occurredDate = parseDateOrNow(occurredAt);
    const decision = checkCutover(occurredDate);
    if (!decision.allowed) {
      this.logger.log(`paperless event ${externalId} skipped: ${decision.reason}`);
      return { ingested: false, reason: decision.reason };
    }

    const event: NewEvent = {
      source: EventSource.Paperless,
      eventType,
      externalId,
      occurredAt: occurredDate,
      payload: payload as unknown as Record<string, unknown>,
      correlationId: null,
    };

    const result = await this.eventRepository.ingest(event);
    if (result.ingested) {
      await this.jobRepository.queue(JobName.ProcessPaperlessDocument, { eventId: result.event.id });
      return { ingested: true, event: result.event };
    }
    return { ingested: false, reason: 'duplicate' };
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function parseDateOrNow(value: string): Date {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function deriveWiseExternalId(payload: WiseWebhookDto): string {
  const parts = [
    payload.subscription_id ?? 'no-sub',
    payload.event_type,
    payload.sent_at ?? payload.data.occurred_at ?? 'no-time',
    String(payload.data.resource?.id ?? 'no-resource'),
  ];
  return parts.join(':');
}

function deriveCorrelationId(payload: WiseWebhookDto): string | null {
  // Group all events for a single Wise transfer by its resource id.
  const id = payload.data.resource?.id;
  if (id === undefined || payload.data.resource?.type !== 'transfer') {
    return null;
  }
  // Postgres uuid column: produce a stable v5-ish string from the resource id.
  // For now we leave correlationId null unless we have a real UUID; transfer-id
  // grouping can be added by a follow-up event handler.
  return null;
}
