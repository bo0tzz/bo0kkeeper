import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { EventSource, JobName, QueueName, WiseTransferState } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { WiseApiRepository } from 'src/repositories/wise-api.repository';
import { WiseTransferRepository } from 'src/repositories/wise-transfer.repository';
import { JobOf } from 'src/types';
import { majorToMinor } from 'src/utils/money';

/**
 * Consumes events that need to mutate `wise_transfer` state. Job handlers run
 * outside the request lifecycle (pg-boss workers); they're idempotent and
 * pull the event row from DB rather than from the job payload.
 */
@Injectable()
export class WiseEventService {
  private readonly logger = new Logger(WiseEventService.name);

  constructor(
    private readonly eventRepository: EventRepository,
    private readonly wiseTransferRepository: WiseTransferRepository,
    private readonly wiseApi: WiseApiRepository,
  ) {}

  /**
   * Apply a Wise `transfers#state-change` event to its corresponding
   * `wise_transfer` row. The wise transfer id lives at
   * `payload.data.resource.id` per Wise's schema.
   */
  @OnJob({ name: JobName.WiseTransferStateChange, queue: QueueName.Webhook })
  async handleWiseTransferStateChange({ eventId }: JobOf<JobName.WiseTransferStateChange>): Promise<void> {
    const event = await this.eventRepository.findById(eventId);
    if (!event) {
      throw new NotFoundException(`Event not found: ${eventId}`);
    }
    if (event.source !== EventSource.Wise || event.eventType !== 'transfers#state-change') {
      this.logger.warn(`Skipping ${event.source}/${event.eventType} on WiseTransferStateChange handler`);
      await this.eventRepository.markProcessed(event.id);
      return;
    }

    const parsed = parseStateChangePayload(event.payload);
    const existing = await this.wiseTransferRepository.findByWiseTransferId(parsed.transferId);
    if (!existing) {
      // We may receive state-changes for transfers that originated outside the
      // system (e.g. user manually creating one in the Wise app). Log and skip;
      // the matching pipeline can backfill later.
      this.logger.warn(`No wise_transfer row for transferId=${parsed.transferId} (event ${event.id})`);
      await this.eventRepository.markProcessed(event.id);
      return;
    }

    // Refetch amounts + rate from Wise so we catch any drift between what
    // we quoted at draft time and what actually moved (user bumps the
    // source amount at SCA time, Wise re-quotes at confirm, etc.). Fees on
    // the /v1/transfers response are absent — we retain the original.
    // Best-effort: a refetch failure still lets the state update land; the
    // reconcile cron picks up any missed amount sync.
    const upstream = await this.wiseApi.getTransfer(Number(parsed.transferId)).catch((error) => {
      this.logger.warn(
        `Refetch failed for wise_transfer ${parsed.transferId}: ${(error as Error).message}; applying state-only update`,
      );
      return null;
    });
    await this.wiseTransferRepository.updateState(parsed.transferId, {
      state: parsed.state,
      stateUpdatedAt: parsed.occurredAt,
      sourceAmountMinor: upstream?.sourceValue == null ? undefined : majorToMinor(upstream.sourceValue),
      targetAmountMinor: upstream?.targetValue == null ? undefined : majorToMinor(upstream.targetValue),
      fxRate: upstream?.rate ?? undefined,
    });
    await this.eventRepository.markProcessed(event.id);
    this.logger.log(`wise_transfer ${parsed.transferId} → ${parsed.state} (event ${event.id})`);
  }
}

type ParsedStateChange = {
  transferId: string;
  state: WiseTransferState;
  occurredAt: Date;
};

function parseStateChangePayload(payload: Record<string, unknown>): ParsedStateChange {
  const data = payload['data'] as Record<string, unknown> | undefined;
  const resource = data?.['resource'] as Record<string, unknown> | undefined;
  const id = resource?.['id'];
  if (id === undefined || id === null) {
    throw new Error('transfer state-change payload missing data.resource.id');
  }
  const state = data?.['current_state'];
  if (typeof state !== 'string') {
    throw new TypeError(`transfer state-change payload missing or non-string current_state (${typeof state})`);
  }
  const occurredAt = data?.['occurred_at'];
  if (typeof occurredAt !== 'string') {
    throw new TypeError(`transfer state-change payload missing occurred_at`);
  }

  return {
    transferId: String(id),
    state: state as WiseTransferState,
    occurredAt: new Date(occurredAt),
  };
}
