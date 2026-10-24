import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import {
  BankingAspspsQueryDto,
  BankingAspspsResponseDto,
  BankingSessionResponseDto,
  BankingStartAuthDto,
  BankingStartAuthResponseDto,
  BankingSyncResponseDto,
  BankTransactionResponseDto,
  BankTxMatchCandidatesDto,
  BankTxMatchCandidatesQueryDto,
  BankTxSetCategoryDto,
  BankTxSetMatchDto,
  ListBankTransactionsQueryDto,
  ListBankTransactionsResponseDto,
} from 'src/dtos/banking.dto';
import { BankTxCategory, EventSource, JobName } from 'src/enum';
import {
  BankTransaction,
  BankTransactionRepository,
  BankTransactionWithLabels,
} from 'src/repositories/bank-transaction.repository';
import { BankingSession, BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { EnableBankingRepository } from 'src/repositories/enable-banking.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { BankMatcherService } from 'src/services/bank-matcher.service';
import { BankingSessionService } from 'src/services/banking-session.service';

/**
 * Admin endpoints for the PSD2 / Enable Banking consent flow.
 *
 * - POST /api/banking/auth/start — admin clicks "Connect bank"; we mint a
 *   pending session, call Enable Banking, return the bank's redirect URL.
 *   The frontend does `window.location = redirectUrl`.
 * - GET  /api/banking/auth/callback — bank redirects the user back here
 *   after SCA. We exchange `code` for a session, mark the row active, and
 *   302 the user to `/banking` in the admin UI.
 * - GET  /api/banking/session — UI fetches the latest session for the
 *   "connection status" card on the banking page.
 */
@ApiTags('Banking')
@Controller('/api/banking')
export class BankingController {
  constructor(
    private readonly sessionService: BankingSessionService,
    private readonly sessionRepository: BankingSessionRepository,
    private readonly jobRepository: JobRepository,
    private readonly bankTransactionRepository: BankTransactionRepository,
    private readonly matcher: BankMatcherService,
    private readonly eventRepository: EventRepository,
    private readonly enableBanking: EnableBankingRepository,
  ) {}

  /**
   * Bank catalog for the picker on /banking. Proxies Enable Banking's
   * `/aspsps`; that endpoint needs a JWT we mint server-side, so the SPA
   * goes through us. Filterable by country (default NL).
   */
  @Get('aspsps')
  @Authenticated()
  @ApiQueryFromDto(BankingAspspsQueryDto)
  @ApiOkResponse({ type: BankingAspspsResponseDto })
  async listAspsps(@Query() query: BankingAspspsQueryDto): Promise<BankingAspspsResponseDto> {
    const country = query.country ?? 'NL';
    const aspsps = await this.enableBanking.listAspsps(country);
    return {
      aspsps: aspsps.map((a) => ({
        name: a.name,
        country: a.country,
        psuTypes: a.psu_types,
      })),
    };
  }

  @Post('auth/start')
  @Authenticated()
  @ApiOkResponse({ type: BankingStartAuthResponseDto })
  async startAuth(@Body() body: BankingStartAuthDto): Promise<BankingStartAuthResponseDto> {
    const result = await this.sessionService.startAuth({
      aspspName: body.aspspName,
      aspspCountry: body.aspspCountry,
      psuType: body.psuType,
    });
    return result;
  }

  @Get('auth/callback')
  @Authenticated()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      res.redirect(302, `/banking?error=${encodeURIComponent(error)}`);
      return;
    }
    if (!code || !state) {
      throw new BadRequestException('Missing code or state on banking callback');
    }
    await this.sessionService.completeCallback({ code, state });
    res.redirect(302, '/banking');
  }

  @Get('session')
  @Authenticated()
  @ApiOkResponse({ type: BankingSessionResponseDto })
  async getLatestSession(): Promise<BankingSessionResponseDto | null> {
    const row = await this.sessionRepository.findLatest();
    if (!row) {
      return null;
    }
    // Earliest baseline across the session's accounts → drift sum window.
    // V1 carries one account in practice, so we compute one shared sum and
    // apply it to every account that has a baseline. Multi-account setups
    // would need a per-account-uid sum (and bank_transaction → account FK,
    // which we don't have today).
    //
    // Pass baseline.asOf as a full timestamp (not sliced to date). The repo
    // filters on bank_transaction.createdAt — rows ingested AFTER baseline
    // capture — so same-day ingests that preceded the baseline don't double
    // count against the live balance that already reflects them.
    const accounts = (row.accountsJson ?? []) as Array<{ baseline?: { asOf: string } }>;
    const earliestBaselineAsOf = accounts
      .map((a) => a.baseline?.asOf)
      .filter((d): d is string => typeof d === 'string')
      .toSorted((a, b) => a.localeCompare(b))[0];
    const ingestedSinceBaseline = earliestBaselineAsOf
      ? await this.bankTransactionRepository.sumIngestedAfter(new Date(earliestBaselineAsOf))
      : 0n;
    return toDto(row, ingestedSinceBaseline);
  }

  /**
   * Admin "Sync now" — enqueue an immediate banking-sync job. We pass the
   * caller's IP through as PSU-IP-Address so Enable Banking marks the call
   * as user-online (exempt from the 4/day PSD2 background cap).
   */
  @Post('sync')
  @Authenticated()
  @ApiOkResponse({ type: BankingSyncResponseDto })
  async sync(@Ip() ip: string): Promise<BankingSyncResponseDto> {
    await this.jobRepository.queue(JobName.BankingSyncAll, { psuIpAddress: ip });
    return { enqueued: true };
  }

  /** Paginated bank_transaction list with optional filters. Drives /banking. */
  @Get('transactions')
  @Authenticated()
  @ApiQueryFromDto(ListBankTransactionsQueryDto)
  @ApiOkResponse({ type: ListBankTransactionsResponseDto })
  async listTransactions(@Query() query: ListBankTransactionsQueryDto): Promise<ListBankTransactionsResponseDto> {
    const { items, total } = await this.bankTransactionRepository.findPaginated({
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      status: query.status,
      offset: (query.page - 1) * query.limit,
      limit: query.limit,
    });
    return { items: items.map((row) => toBankTransactionDto(row)), total };
  }

  /**
   * Candidates for manual link.
   *
   * - With a text query: substring match across all three types, no amount or
   *   direction filter — operator is searching deliberately.
   * - With `bankTxId` (and no query): directional filter + amount-proximity
   *   sort. Outflow bank_txs only surface expenses; inflow bank_txs only
   *   surface invoices + wise_transfers. Within each applicable type,
   *   candidates are ordered closest-amount-first.
   * - With neither: recent rows of each type.
   */
  @Get('match-candidates')
  @Authenticated()
  @ApiQueryFromDto(BankTxMatchCandidatesQueryDto)
  @ApiOkResponse({ type: BankTxMatchCandidatesDto })
  async matchCandidates(@Query() query: BankTxMatchCandidatesQueryDto): Promise<BankTxMatchCandidatesDto> {
    const candidates = await this.matcher.findMatchCandidates(query.q, { bankTxId: query.bankTxId });
    return {
      transfers: candidates.transfers.map((t) => ({
        id: t.id,
        wiseTransferId: t.wiseTransferId,
        ourReference: t.ourReference,
        state: t.state,
        sourceCurrency: t.sourceCurrency,
        sourceAmountMinor: String(t.sourceAmountMinor),
        targetCurrency: t.targetCurrency,
        targetAmountMinor: String(t.targetAmountMinor),
        createdAt: new Date(t.createdAt).toISOString(),
      })),
      invoices: candidates.invoices.map((i) => ({
        id: i.id,
        number: i.number,
        totalMinor: String(i.totalMinor),
        currency: i.currency,
        issuedAt: new Date(i.issuedAt).toISOString().slice(0, 10),
        clientName: i.clientName,
      })),
      expenses: candidates.expenses.map((e) => ({
        id: e.id,
        vendor: e.vendor,
        amountMinor: String(e.amountMinor),
        currency: e.currency,
        expenseDate: new Date(e.expenseDate).toISOString().slice(0, 10),
        status: e.status,
      })),
    };
  }

  /** Operator-driven manual match. Sets confidence=manual, runs sheet append. */
  @Put('transactions/:id/match')
  @Authenticated()
  @ApiOkResponse({ type: BankTransactionResponseDto })
  async setMatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BankTxSetMatchDto,
  ): Promise<BankTransactionResponseDto> {
    const row = await this.matcher.manualMatch(id, { type: body.type, targetId: body.targetId });
    return toBankTransactionDto(row);
  }

  /**
   * Tag a row with a manual category (tax / self_transfer / fee / ignored)
   * — or pass `null` to clear. Categorized rows are excluded from the
   * unmatched warning surface.
   */
  @Put('transactions/:id/category')
  @Authenticated()
  @ApiOkResponse({ type: BankTransactionResponseDto })
  async setCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BankTxSetCategoryDto,
  ): Promise<BankTransactionResponseDto> {
    const row = await this.bankTransactionRepository.setCategory(id, body.category as BankTxCategory | null);
    if (!row) {
      throw new NotFoundException();
    }
    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: row.category ? 'banking.tx.categorized' : 'banking.tx.uncategorized',
      payload: { bankTxId: row.id, category: row.category },
    });
    return toBankTransactionDto(row);
  }

  /** Operator unlink — clears all match fields. */
  @Delete('transactions/:id/match')
  @Authenticated()
  @ApiOkResponse({ type: BankTransactionResponseDto })
  async clearMatch(@Param('id', ParseUUIDPipe) id: string): Promise<BankTransactionResponseDto> {
    const row = await this.matcher.clearMatch(id);
    return toBankTransactionDto(row);
  }

  /**
   * Re-run the matcher against an existing row using current rules. Used to
   * pull rows in their pre-rule-change state into the new state without
   * out-of-band SQL. Initial scope: categorised-but-not-matched rows.
   * Already-matched rows must be unmatched first.
   */
  @Post('transactions/:id/reprocess')
  @Authenticated()
  @ApiOkResponse({ type: BankTransactionResponseDto })
  async reprocess(@Param('id', ParseUUIDPipe) id: string): Promise<BankTransactionResponseDto> {
    try {
      const { row } = await this.matcher.reprocess(id);
      return toBankTransactionDto(row);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('not found')) {
        throw new NotFoundException(message);
      }
      if (message.includes('currently matched')) {
        throw new BadRequestException(message);
      }
      throw error;
    }
  }
}

function toBankTransactionDto(row: BankTransaction | BankTransactionWithLabels): BankTransactionResponseDto {
  const withLabels = row as Partial<BankTransactionWithLabels>;
  return {
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    txDate: new Date(row.txDate).toISOString().slice(0, 10),
    amountMinor: String(row.amountMinor),
    currency: row.currency,
    counterpartyName: row.counterpartyName,
    counterpartyIban: row.counterpartyIban,
    description: row.description,
    matchedTransferId: row.matchedTransferId,
    matchedInvoiceId: row.matchedInvoiceId,
    matchedExpenseId: row.matchedExpenseId,
    matchedTransferLabel: withLabels.matchedTransferLabel ?? null,
    matchedInvoiceLabel: withLabels.matchedInvoiceLabel ?? null,
    matchedExpenseLabel: withLabels.matchedExpenseLabel ?? null,
    matchedAt: row.matchedAt ? new Date(row.matchedAt).toISOString() : null,
    matchConfidence: row.matchConfidence,
    category: row.category,
  };
}

type AccountJsonShape = {
  uid: string;
  iban?: string | null;
  currency: string;
  name?: string | null;
  product?: string | null;
  balance?: { amountMinor: string; currency: string; asOf: string } | null;
  baseline?: { amountMinor: string; currency: string; asOf: string } | null;
};

function toDto(row: BankingSession, ingestedSinceBaseline = 0n): BankingSessionResponseDto {
  return {
    id: row.id,
    status: row.status,
    aspspName: row.aspspName,
    aspspCountry: row.aspspCountry,
    psuType: row.psuType,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    lastSyncedAt: row.lastSyncedAt ? new Date(row.lastSyncedAt).toISOString() : null,
    accounts: ((row.accountsJson ?? []) as AccountJsonShape[]).map((a) => {
      let expectedBalanceMinor: string | null = null;
      let balanceDiscrepancyMinor: string | null = null;
      if (a.baseline) {
        const expected = BigInt(a.baseline.amountMinor) + ingestedSinceBaseline;
        expectedBalanceMinor = String(expected);
        if (a.balance) {
          balanceDiscrepancyMinor = String(BigInt(a.balance.amountMinor) - expected);
        }
      }
      return {
        uid: a.uid,
        iban: a.iban ?? null,
        currency: a.currency,
        name: a.name ?? null,
        product: a.product ?? null,
        balance: a.balance ?? null,
        expectedBalanceMinor,
        balanceDiscrepancyMinor,
      };
    }),
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
