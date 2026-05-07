import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createVerify } from 'node:crypto';
import { loadConfig } from 'src/config';
import { WiseWebhookDto } from 'src/dtos/webhook.dto';
import { EventSource } from 'src/enum';
import { EventRepository, IngestResult, NewEvent } from 'src/repositories/event.repository';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly wiseConfig = loadConfig().wise;

  constructor(private readonly eventRepository: EventRepository) {}

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
   *
   * `externalId` priority: explicit X-Delivery-Id header → derived from
   * `subscription_id + sent_at + resource.id` → `subscription_id + event_type + sent_at`.
   * Whichever is unique enough to deduplicate retries.
   */
  ingestWiseEvent(payload: WiseWebhookDto, deliveryId?: string): Promise<IngestResult> {
    const externalId = deliveryId ?? deriveWiseExternalId(payload);
    const occurredAt = payload.data.occurred_at ?? payload.sent_at ?? new Date().toISOString();

    const event: NewEvent = {
      source: EventSource.Wise,
      eventType: payload.event_type,
      externalId,
      occurredAt: new Date(occurredAt),
      payload: payload as unknown as Record<string, unknown>,
      correlationId: deriveCorrelationId(payload),
    };

    return this.eventRepository.ingest(event);
  }
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
