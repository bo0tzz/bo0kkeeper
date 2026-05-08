import { Body, Controller, Delete, Get, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import {
  ClosePeriodDto,
  QuarterlyAggregateQueryDto,
  QuarterlyAggregateResponseDto,
  mapAggregate,
} from 'src/dtos/aggregator.dto';
import { EventSource } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { PeriodCloseRepository } from 'src/repositories/period-close.repository';
import { BookkeepingExportService } from 'src/services/bookkeeping-export.service';
import { QuarterlyAggregatorService } from 'src/services/quarterly-aggregator.service';

@ApiTags('Aggregator')
@Controller('/api/aggregator')
export class AggregatorController {
  constructor(
    private readonly aggregator: QuarterlyAggregatorService,
    private readonly exportService: BookkeepingExportService,
    private readonly periodCloseRepository: PeriodCloseRepository,
    private readonly eventRepository: EventRepository,
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
    const [aggregate, close] = await Promise.all([
      this.aggregator.aggregate(query.year, query.quarter),
      this.periodCloseRepository.findByQuarter(query.year, query.quarter),
    ]);
    return mapAggregate(aggregate, close ? new Date(close.closedAt) : null);
  }

  /**
   * Mark a quarter as filed with the accountant. Doesn't block edits to rows
   * inside the period (corrections happen) — the UI surfaces a "closed" badge
   * + warning so the user notices when they're about to touch settled data.
   */
  @Post('quarterly/close')
  @Authenticated()
  @ApiQueryFromDto(QuarterlyAggregateQueryDto)
  async closePeriod(
    @Query() query: QuarterlyAggregateQueryDto,
    @Body() body: ClosePeriodDto,
  ): Promise<{ closedAt: string }> {
    const close = await this.periodCloseRepository.close({
      year: query.year,
      quarter: query.quarter,
      notes: body.notes ?? null,
    });
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'aggregator.period.closed',
      payload: { year: close.year, quarter: close.quarter, notes: close.notes },
    });
    return { closedAt: new Date(close.closedAt).toISOString() };
  }

  @Delete('quarterly/close')
  @Authenticated()
  @ApiQueryFromDto(QuarterlyAggregateQueryDto)
  async reopenPeriod(@Query() query: QuarterlyAggregateQueryDto): Promise<{ reopened: true }> {
    await this.periodCloseRepository.reopen(query.year, query.quarter);
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'aggregator.period.reopened',
      payload: { year: query.year, quarter: query.quarter },
    });
    return { reopened: true };
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
