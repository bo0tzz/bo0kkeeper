import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Authenticated } from 'src/decorators';
import { QuarterlyAggregateQueryDto, QuarterlyAggregateResponseDto, mapAggregate } from 'src/dtos/aggregator.dto';
import { QuarterlyAggregatorService } from 'src/services/quarterly-aggregator.service';

@ApiTags('Aggregator')
@Controller('/api/aggregator')
export class AggregatorController {
  constructor(private readonly aggregator: QuarterlyAggregatorService) {}

  /**
   * Compute the BTW-aangifte aggregate for one quarter. Read-only — the data
   * lives in invoices/expenses/bank_transaction; this endpoint just rolls it
   * up. Warnings field flags filings that need user attention before submit.
   */
  @Get('quarterly')
  @Authenticated()
  async getQuarterlyAggregate(@Query() query: QuarterlyAggregateQueryDto): Promise<QuarterlyAggregateResponseDto> {
    const aggregate = await this.aggregator.aggregate(query.year, query.quarter);
    return mapAggregate(aggregate);
  }
}
