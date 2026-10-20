import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import {
  DraftFromEventDto,
  ListWiseTransfersQueryDto,
  ListWiseTransfersResponseDto,
  WiseAwaitingInvoiceCountDto,
  WiseReconcileResponseDto,
  WiseTransferResponseDto,
} from 'src/dtos/wise.dto';
import { JobName, WiseTransferState } from 'src/enum';
import { JobRepository } from 'src/repositories/job.repository';
import { WiseTransferRepository, WiseTransferRow } from 'src/repositories/wise-transfer.repository';
import { WiseDraftService } from 'src/services/wise-draft.service';

@ApiTags('Wise')
@Controller('/api/wise')
export class WiseController {
  constructor(
    private readonly wiseDraftService: WiseDraftService,
    private readonly jobRepository: JobRepository,
    private readonly wiseTransferRepository: WiseTransferRepository,
  ) {}

  /** Paginated wise_transfer list with optional state filter, newest first. */
  @Get('transfers')
  @Authenticated()
  @ApiQueryFromDto(ListWiseTransfersQueryDto)
  @ApiOkResponse({ type: ListWiseTransfersResponseDto })
  async listTransfers(@Query() query: ListWiseTransfersQueryDto): Promise<ListWiseTransfersResponseDto> {
    const { items, total } = await this.wiseTransferRepository.findPaginated({
      state: query.state as WiseTransferState | undefined,
      offset: (query.page - 1) * query.limit,
      limit: query.limit,
    });
    return {
      items: items.map((row) => ({
        ...mapWiseTransfer(row),
        linkedInvoiceId: row.linkedInvoiceId,
        linkedInvoiceNumber: row.linkedInvoiceNumber,
      })),
      total,
    };
  }

  /**
   * Draft a USD→EUR transfer in Wise from the given inbound credit event.
   * Returns the persisted wise_transfer row. The user still needs to SCA-confirm
   * the draft in the Wise app for money to actually move.
   */
  @Post('draft-from-event/:eventId')
  @Authenticated()
  @ApiOkResponse({ type: WiseTransferResponseDto })
  async draftFromEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: DraftFromEventDto,
  ): Promise<WiseTransferResponseDto> {
    const row = await this.wiseDraftService.draftFromEvent({
      eventId,
      ourReference: dto.ourReference,
      allowUnderCredit: dto.allowUnderCredit,
    });
    return mapWiseTransfer(row);
  }

  /**
   * Trigger an immediate Wise reconcile — pulls non-terminal wise_transfer
   * rows from the Wise API and reapplies their state. Same job pg-boss runs
   * on the 4h cron; this just enqueues an out-of-band tick.
   */
  @Post('reconcile')
  @Authenticated()
  @ApiOkResponse({ type: WiseReconcileResponseDto })
  async reconcileNow(): Promise<WiseReconcileResponseDto> {
    await this.jobRepository.queue(JobName.WiseReconcile, {});
    return { enqueued: true };
  }

  /**
   * Count outbound transfers in `outgoing_payment_sent` that still have no
   * linked invoice. Drives the dashboard's "Wise transfer awaiting invoice"
   * tile — populated when auto-compose declined (or hasn't fired yet) and
   * the operator needs to run the manual compose flow.
   */
  @Get('awaiting-invoice-count')
  @Authenticated()
  @ApiOkResponse({ type: WiseAwaitingInvoiceCountDto })
  async awaitingInvoiceCount(): Promise<WiseAwaitingInvoiceCountDto> {
    const count = await this.wiseTransferRepository.countOutgoingAwaitingInvoice();
    return { count };
  }

  /**
   * Mark a settled outbound transfer as "not invoiceable" so it stops
   * showing in the "Wise transfer awaiting invoice" count and the
   * auto-compose job declines on it. One-way; un-dismissing is a direct
   * DB flip if it comes up.
   */
  @Post('transfers/:id/dismiss-invoice')
  @Authenticated()
  @ApiOkResponse({ type: WiseTransferResponseDto })
  async dismissInvoice(@Param('id', ParseUUIDPipe) id: string): Promise<WiseTransferResponseDto> {
    const updated = await this.wiseTransferRepository.markInvoiceDismissed(id, new Date());
    if (!updated) {
      throw new NotFoundException(`wise_transfer ${id} not found`);
    }
    return mapWiseTransfer(updated);
  }
}

function mapWiseTransfer(row: WiseTransferRow): WiseTransferResponseDto {
  return {
    id: row.id,
    wiseTransferId: row.wiseTransferId,
    direction: row.direction,
    state: row.state,
    sourceAmountMinor: String(row.sourceAmountMinor),
    sourceCurrency: row.sourceCurrency,
    targetAmountMinor: String(row.targetAmountMinor),
    targetCurrency: row.targetCurrency,
    fxRate: row.fxRate,
    feeMinor: String(row.feeMinor),
    feeCurrency: row.feeCurrency,
    ourReference: row.ourReference,
    correlationId: row.correlationId,
    invoiceDismissedAt: row.invoiceDismissedAt
      ? row.invoiceDismissedAt instanceof Date
        ? row.invoiceDismissedAt.toISOString()
        : new Date(row.invoiceDismissedAt).toISOString()
      : null,
  } as WiseTransferResponseDto;
}
