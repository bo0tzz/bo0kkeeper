import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import {
  DraftFromEventDto,
  ListWiseTransfersQueryDto,
  ListWiseTransfersResponseDto,
  WiseTransferResponseDto,
} from 'src/dtos/wise.dto';
import { JobName, WiseTransferState } from 'src/enum';
import { WiseTransferRepository, WiseTransferRow } from 'src/repositories/wise-transfer.repository';
import { JobRepository } from 'src/repositories/job.repository';
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
  async listTransfers(@Query() query: ListWiseTransfersQueryDto): Promise<ListWiseTransfersResponseDto> {
    const { items, total } = await this.wiseTransferRepository.findPaginated({
      state: query.state as WiseTransferState | undefined,
      offset: (query.page - 1) * query.limit,
      limit: query.limit,
    });
    return { items: items.map((row) => mapWiseTransfer(row)), total };
  }

  /**
   * Draft a USD→EUR transfer in Wise from the given inbound credit event.
   * Returns the persisted wise_transfer row. The user still needs to SCA-confirm
   * the draft in the Wise app for money to actually move.
   */
  @Post('draft-from-event/:eventId')
  @Authenticated()
  async draftFromEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: DraftFromEventDto,
  ): Promise<WiseTransferResponseDto> {
    const row = await this.wiseDraftService.draftFromEvent({
      eventId,
      ourReference: dto.ourReference,
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
  async reconcileNow(): Promise<{ enqueued: true }> {
    await this.jobRepository.queue(JobName.WiseReconcile, {});
    return { enqueued: true };
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
  } as WiseTransferResponseDto;
}
