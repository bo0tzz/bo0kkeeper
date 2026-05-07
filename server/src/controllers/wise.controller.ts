import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Authenticated } from 'src/decorators';
import { DraftFromEventDto, WiseTransferResponseDto } from 'src/dtos/wise.dto';
import { WiseTransferRow } from 'src/repositories/wise-transfer.repository';
import { WiseDraftService } from 'src/services/wise-draft.service';

@ApiTags('Wise')
@Controller('/api/wise')
export class WiseController {
  constructor(private readonly wiseDraftService: WiseDraftService) {}

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
