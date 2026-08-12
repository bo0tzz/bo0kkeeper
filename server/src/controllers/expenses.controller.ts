import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { loadConfig } from 'src/config';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import {
  ExpenseApproveDto,
  ExpenseRejectDto,
  ExpenseResponseDto,
  ExpenseUpdateDto,
  ListExpensesQueryDto,
  ListExpensesResponseDto,
  mapExpense,
  RescanPaperlessResponseDto,
} from 'src/dtos/expense.dto';
import { EventSource } from 'src/enum';
import { EventRepository } from 'src/repositories/event.repository';
import { ExpenseRepository, ExpenseUpdate } from 'src/repositories/expense.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { SettingsService } from 'src/services/settings.service';
import { SheetSyncService } from 'src/services/sheet-sync.service';
import { WebhookService } from 'src/services/webhook.service';

@ApiTags('Expenses')
@Controller('/api/expenses')
export class ExpensesController {
  constructor(
    private readonly expenseRepository: ExpenseRepository,
    private readonly eventRepository: EventRepository,
    private readonly paperlessService: PaperlessRepository,
    private readonly settingsService: SettingsService,
    private readonly sheetSync: SheetSyncService,
    private readonly webhookService: WebhookService,
  ) {}

  @Get()
  @Authenticated()
  @ApiQueryFromDto(ListExpensesQueryDto)
  async listExpenses(@Query() query: ListExpensesQueryDto): Promise<ListExpensesResponseDto> {
    const page = await this.expenseRepository.findMany({
      status: query.status,
      locationClass: query.locationClass,
      from: query.from,
      to: query.to,
      matched: query.matched,
      limit: query.limit,
      offset: query.offset,
    });
    return {
      items: page.items.map((row) => mapExpense(row)),
      total: page.total,
      hasMore: page.hasMore,
    } as ListExpensesResponseDto;
  }

  @Get(':id')
  @Authenticated()
  async getExpense(@Param('id', ParseUUIDPipe) id: string): Promise<ExpenseResponseDto> {
    const row = await this.expenseRepository.findById(id);
    if (!row) {
      throw new NotFoundException();
    }
    return mapExpense(row);
  }

  /**
   * Patch a pending expense without changing its status — used while reviewing
   * (filling in amount, BTW split, category) before the user commits to approve.
   */
  @Patch(':id')
  @Authenticated()
  async updateExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExpenseUpdateDto,
  ): Promise<ExpenseResponseDto> {
    const row = await this.expenseRepository.update(id, dto as unknown as ExpenseUpdate);
    if (!row) {
      throw new NotFoundException();
    }
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'expense.updated',
      payload: { expenseId: row.id, vendor: row.vendor },
    });
    return mapExpense(row);
  }

  /**
   * Approve a pending expense. Body fields are merged in atomically with the
   * status flip, so the UI can submit "save + approve" in a single request.
   *
   * Sheet row writes here IFF the expense already has a bank-tx linked
   * (the other half of the `matched ∧ approved` condition); otherwise this
   * is a pure DB state change and the sheet row fires later when a bank-tx
   * link lands. Approved-but-unmatched expenses surface on the dashboard
   * tile so they don't fall through the cracks.
   */
  @Post(':id/approve')
  @Authenticated()
  async approveExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExpenseApproveDto,
  ): Promise<ExpenseResponseDto> {
    // Belt-and-suspenders check for the DB CHECK constraint —
    // foreign-currency expenses need a wise_transfer link so we can
    // book EUR at sweep-clear time. Doing it here gives a clean 400
    // instead of a Postgres constraint-violation 500.
    const existing = await this.expenseRepository.findById(id);
    if (!existing) {
      throw new NotFoundException();
    }
    const effectiveCurrency = dto.currency ?? existing.currency;
    const effectiveWiseTransferId = dto.wiseTransferId ?? existing.wiseTransferId;
    if (effectiveCurrency !== 'EUR' && !effectiveWiseTransferId) {
      throw new BadRequestException(
        `Foreign-currency (${effectiveCurrency}) expenses must be linked to a Wise sweep — pick one under "Paid from Wise sweep".`,
      );
    }
    const row = await this.expenseRepository.approve(id, dto as unknown as ExpenseUpdate);
    if (!row) {
      throw new NotFoundException();
    }
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'expense.approved',
      payload: {
        expenseId: row.id,
        vendor: row.vendor,
        amountMinor: String(row.amountMinor),
        currency: row.currency,
      },
    });
    // No-op when no bank-tx is matched yet; idempotent on re-approval.
    await this.sheetSync.writeExpenseRowIfReady(row.id);
    return mapExpense(row);
  }

  /**
   * Redirect to the paperless document UI for this expense's source receipt.
   * Every expense has a paperlessDocId by construction (created from a
   * paperless workflow webhook), so this should never 404 in normal use.
   */
  @Get(':id/paperless')
  @Authenticated()
  async paperlessRedirect(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const expense = await this.expenseRepository.findById(id);
    if (!expense) {
      throw new NotFoundException('Expense not found');
    }
    const baseUrl = loadConfig().paperless.baseUrl;
    if (!baseUrl) {
      throw new NotFoundException('Paperless not configured');
    }
    res.redirect(302, `${baseUrl.replace(/\/$/, '')}/documents/${expense.paperlessDocId}/`);
  }

  /**
   * Operator-driven backfill — walk paperless's REST API for documents that
   * carry every configured gate tag and were created on or after CUTOVER_DATE,
   * then synthesize a webhook event per doc through the existing pipeline.
   *
   * Use cases:
   *  - paperless's webhook delivery dropped (no retry on transport-level
   *    failures past 3 HTTP-error retries).
   *  - operator tagged a doc AFTER the workflow trigger window — Document
   *    Updated re-fires for live updates only.
   *  - first time wiring up the workflow against an inbox of pre-tagged docs.
   *
   * Idempotent: events are keyed on `paperless:<doc_id>`, expenses on
   * `paperlessDocId`. Re-running is safe.
   */
  @Post('rescan-paperless')
  @Authenticated()
  async rescanPaperless(): Promise<RescanPaperlessResponseDto> {
    const cutover = loadConfig().cutoverDate;
    if (!cutover) {
      throw new BadRequestException(
        'CUTOVER_DATE is unset — set it in env before running a backfill so historical docs stay out',
      );
    }
    const tags = await this.settingsService.getPaperlessExpenseTags();
    if (tags.length === 0) {
      throw new BadRequestException(
        'No expense tag-gate configured. Set Settings → Paperless tags → Expense ingestion tag-gate first.',
      );
    }

    const docs = await this.paperlessService.listDocumentsTaggedAllOf(tags, cutover);
    let enqueued = 0;
    let alreadyIngested = 0;
    let droppedBeforeCutover = 0;
    for (const doc of docs) {
      const result = await this.webhookService.ingestPaperlessEvent({
        document_id: doc.id,
        created: doc.created,
      });
      if (result.ingested) {
        enqueued += 1;
      } else if (result.reason === 'duplicate') {
        alreadyIngested += 1;
      } else if (result.reason === 'before_cutover') {
        droppedBeforeCutover += 1;
      }
    }

    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'expenses.rescan_paperless',
      payload: { scanned: docs.length, enqueued, alreadyIngested, droppedBeforeCutover, since: cutover },
    });
    return { scanned: docs.length, enqueued, alreadyIngested, droppedBeforeCutover };
  }

  /** Reject the expense (paperless doc was misclassified, isn't a business expense, etc). */
  @Post(':id/reject')
  @Authenticated()
  async rejectExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExpenseRejectDto,
  ): Promise<ExpenseResponseDto> {
    const row = await this.expenseRepository.reject(id, dto.notes);
    if (!row) {
      throw new NotFoundException();
    }
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'expense.rejected',
      payload: { expenseId: row.id, vendor: row.vendor, notes: dto.notes ?? null },
    });
    return mapExpense(row);
  }
}
