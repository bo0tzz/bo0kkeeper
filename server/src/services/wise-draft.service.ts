import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { loadConfig } from 'src/config';
import { EventSource, WiseTransferDirection, WiseTransferState } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { WiseApiRepository } from 'src/repositories/wise-api.repository';
import { NewWiseTransfer, WiseTransferRepository, WiseTransferRow } from 'src/repositories/wise-transfer.repository';
import { majorToMinor } from 'src/utils/money';

const TARGET_CURRENCY = 'EUR';

export type DraftFromEventInput = {
  eventId: string;
  /**
   * Our `TXN-NNNN` reference for the outgoing transfer. Surfaces in the bank statement.
   * Optional — when omitted, the next reference is allocated from the
   * `wise_txn_sequence` Postgres sequence.
   */
  ourReference?: string;
  /**
   * Skip the "balance ≥ credit" guard. See DraftFromEventDto for context —
   * the operator has intentionally drained part of the balance (typically a
   * Wise card charge) and wants the sweep to run against what's left rather
   * than fail.
   */
  allowUnderCredit?: boolean;
};

/**
 * Orchestrates "inbound credit → drafted Wise transfer." Doesn't fund anything —
 * the user opens the Wise app and SCA-confirms the draft before money moves.
 *
 * Steps:
 *   1. Resolve the source event (must be `wise.balances.credit`).
 *   2. Quote USD→EUR for the credited amount via WiseApiRepository.
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
    private readonly wiseApiService: WiseApiRepository,
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
    // Draft from the CURRENT balance, not the event's credit amount. A
    // Wise draft locks its amount at SCA time — the user can't top up
    // from the app to include an earlier cashback that's still sitting
    // in the balance. Sweeping ensures the whole balance moves in one
    // transfer, and small pending credits naturally roll into the next
    // larger one.
    const balanceMinor = await this.wiseApiService.getBalanceMinor(credit.currency);
    if (balanceMinor < credit.amountMinor && !input.allowUnderCredit) {
      // Balance is smaller than this event's credit — either the operator
      // already spent some of it (Wise card charge, direct payment) or Wise
      // has held the funds. Fail loudly rather than silently under-draft.
      // Set `allowUnderCredit` on the request when the shortfall is
      // intentional (e.g. "spent $200 on the card, sweep the rest").
      throw new BadRequestException(
        `Wise ${credit.currency} balance is ${balanceMinor} minor but event #${input.eventId} credited ${credit.amountMinor} — pass allowUnderCredit=true if this shortfall is intentional`,
      );
    }
    if (balanceMinor === 0n) {
      throw new BadRequestException(
        `Wise ${credit.currency} balance is zero for event #${input.eventId}; nothing to draft`,
      );
    }
    const ourReference = input.ourReference ?? (await this.wiseTransferRepository.allocateTxnReference());
    this.logger.log(
      `Drafting transfer from event ${event.id}: sweeping ${balanceMinor} minor ${credit.currency} balance ` +
        `(event credited ${credit.amountMinor}) → ${TARGET_CURRENCY} as ${ourReference}`,
    );

    const quote = await this.wiseApiService.createQuote({
      sourceCurrency: credit.currency,
      targetCurrency: TARGET_CURRENCY,
      sourceAmountMinor: balanceMinor,
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
      // The invoice compose flow needs the original credit amount (what the
      // client paid), not the swept amount — those diverge whenever we
      // sweep under credit because of a Wise-side spend. Record it here so
      // compose doesn't have to walk back to the source event.
      originalCreditMinor: credit.amountMinor,
      targetAmountMinor: quote.targetAmountMinor,
      targetCurrency: quote.targetCurrency,
      fxRate: quote.rate,
      feeMinor: quote.feeMinor,
      feeCurrency: quote.feeCurrency,
      state: mapTransferState(transfer.state),
      // Prefer Wise's `created` (their server-side creation moment, which IS
      // when this state became valid) over our wall-clock time. Same shape
      // as the `asOf` fix in BankingSyncService — don't substitute local
      // clock when the upstream source-of-truth value is available.
      stateUpdatedAt: transfer.created ? new Date(transfer.created) : new Date(),
      ourReference,
      counterpartyName: null,
      correlationId: event.correlationId,
    };
    const created = await this.wiseTransferRepository.create(row);
    // Drop the source credit event out of the `pending` inbox — we've now
    // turned it into a wise_transfer, so it's no longer awaiting action.
    // Without this the /wise drafts list keeps showing it forever.
    await this.eventRepository.markProcessed(event.id);
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
    amountMinor: majorToMinor(amount),
  };
}

function mapTransferState(wiseState: string): WiseTransferState {
  // Wise emits its own state strings. We coerce the known ones; unknown stays as string and is
  // safe-cast (the column is `character varying` underneath).
  return wiseState as WiseTransferState;
}
