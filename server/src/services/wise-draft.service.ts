import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { loadConfig } from 'src/config';
import { EventSource, WiseTransferDirection, WiseTransferState } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { NewWiseTransfer, WiseTransferRepository, WiseTransferRow } from 'src/repositories/wise-transfer.repository';
import { WiseApiService } from 'src/services/wise-api.service';

const TARGET_CURRENCY = 'EUR';

export type DraftFromEventInput = {
  eventId: string;
  /**
   * Our `TXN-NNNN` reference for the outgoing transfer. Surfaces in the bank statement.
   * Optional — when omitted, the next reference is allocated from the
   * `wise_txn_sequence` Postgres sequence.
   */
  ourReference?: string;
};

/**
 * Orchestrates "inbound credit → drafted Wise transfer." Doesn't fund anything —
 * the user opens the Wise app and SCA-confirms the draft before money moves.
 *
 * Steps:
 *   1. Resolve the source event (must be `wise.balances.credit`).
 *   2. Quote USD→EUR for the credited amount via WiseApiService.
 *   3. Create a transfer to the configured target recipient with `ourReference`.
 *   4. Persist a `wise_transfer` row keyed on Wise's transfer id.
 *
 * Inbound state-change webhooks update the row's `state` later; that flow is a
 * separate handler.
 */
@Injectable()
export class WiseDraftService {
  private readonly logger = new Logger(WiseDraftService.name);
  private readonly config = loadConfig().wise;

  constructor(
    private readonly eventRepository: EventRepository,
    private readonly wiseTransferRepository: WiseTransferRepository,
    private readonly wiseApiService: WiseApiService,
  ) {}

  async draftFromEvent(input: DraftFromEventInput): Promise<WiseTransferRow> {
    const event = await this.eventRepository.findById(input.eventId);
    if (!event) {
      throw new NotFoundException(`Event not found: ${input.eventId}`);
    }
    if (event.source !== EventSource.Wise || event.eventType !== 'balances#credit') {
      throw new BadRequestException(
        `Event ${input.eventId} is not a Wise balance credit (got ${event.source}/${event.eventType})`,
      );
    }

    const recipientId = this.config.targetRecipientId;
    if (recipientId === undefined) {
      throw new Error('WISE_TARGET_RECIPIENT_ID is not configured');
    }

    const credit = parseBalanceCreditPayload(event.payload);
    const ourReference = input.ourReference ?? (await this.wiseTransferRepository.allocateTxnReference());
    this.logger.log(
      `Drafting transfer from event ${event.id}: ${credit.amount} ${credit.currency} → ${TARGET_CURRENCY} as ${ourReference}`,
    );

    const quote = await this.wiseApiService.createQuote({
      sourceCurrency: credit.currency,
      targetCurrency: TARGET_CURRENCY,
      sourceAmountMinor: credit.amountMinor,
    });

    const transfer = await this.wiseApiService.createTransfer({
      quoteId: quote.id,
      recipientId,
      reference: ourReference,
    });

    const row: NewWiseTransfer = {
      wiseTransferId: String(transfer.id),
      direction: WiseTransferDirection.Out,
      sourceAmountMinor: quote.sourceAmountMinor,
      sourceCurrency: quote.sourceCurrency,
      targetAmountMinor: quote.targetAmountMinor,
      targetCurrency: quote.targetCurrency,
      fxRate: quote.rate,
      feeMinor: quote.feeMinor,
      feeCurrency: quote.feeCurrency,
      state: mapTransferState(transfer.state),
      stateUpdatedAt: new Date(),
      ourReference,
      counterpartyName: null,
      correlationId: event.correlationId,
    };
    const created = await this.wiseTransferRepository.create(row);
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'wise.drafted',
      payload: {
        wiseTransferId: created.wiseTransferId,
        ourReference: created.ourReference,
        sourceCurrency: created.sourceCurrency,
        sourceAmountMinor: String(created.sourceAmountMinor),
        targetCurrency: created.targetCurrency,
        targetAmountMinor: String(created.targetAmountMinor),
        sourceEventId: event.id,
      },
      correlationId: event.correlationId ?? undefined,
    });
    return created;
  }
}

type ParsedCredit = {
  currency: string;
  amount: number;
  amountMinor: bigint;
};

function parseBalanceCreditPayload(payload: Record<string, unknown>): ParsedCredit {
  const data = payload['data'] as Record<string, unknown> | undefined;
  if (!data) {
    throw new BadRequestException('Wise balance-credit payload missing `data`');
  }
  const amount = Number(data['amount']);
  const currency = data['currency'];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestException(`Invalid amount on balance-credit: ${data['amount']}`);
  }
  if (typeof currency !== 'string') {
    throw new BadRequestException(`Invalid currency on balance-credit: ${typeof currency}`);
  }
  return {
    currency,
    amount,
    amountMinor: BigInt(Math.round(amount * 100)),
  };
}

function mapTransferState(wiseState: string): WiseTransferState {
  // Wise emits its own state strings. We coerce the known ones; unknown stays as string and is
  // safe-cast (the column is `character varying` underneath).
  return wiseState as WiseTransferState;
}
