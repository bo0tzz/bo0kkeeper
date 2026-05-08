import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import { QuarterlyAggregateQueryDto, QuarterlyAggregateResponseDto, mapAggregate } from 'src/dtos/aggregator.dto';
import { BookkeepingExportService } from 'src/services/bookkeeping-export.service';
import { QuarterlyAggregatorService } from 'src/services/quarterly-aggregator.service';

@ApiTags('Aggregator')
@Controller('/api/aggregator')
export class AggregatorController {
  constructor(
    private readonly aggregator: QuarterlyAggregatorService,
    private readonly exportService: BookkeepingExportService,
  ) {}

  /**
   * Compute the BTW-aangifte aggregate for one quarter. Read-only — the data
   * lives in invoices/expenses/bank_transaction; this endpoint just rolls it
   * up. Warnings field flags filings that need user attention before submit.
   */
  @Get('quarterly')
  @Authenticated()
  @ApiQueryFromDto(QuarterlyAggregateQueryDto)
  async getQuarterlyAggregate(@Query() query: QuarterlyAggregateQueryDto): Promise<QuarterlyAggregateResponseDto> {
    const aggregate = await this.aggregator.aggregate(query.year, query.quarter);
    return mapAggregate(aggregate);
  }

  /**
   * Stream the accountant's "Bookkeeping list" XLSX for the given quarter.
   * Layout matches the existing manually-typed file the user has been
   * shipping to their accountant: outbound + inbound invoice sections,
   * each split by location class (Domestic / EU / Non EU).
   */
  @Get('quarterly/export.xlsx')
  @Authenticated()
  @ApiQueryFromDto(QuarterlyAggregateQueryDto)
  async exportQuarterly(
    @Query() query: QuarterlyAggregateQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.exportService.exportQuarter(query.year, query.quarter);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.length),
    });
    res.end(buffer);
  }
}
