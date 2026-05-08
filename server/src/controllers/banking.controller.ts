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
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Authenticated } from 'src/decorators';
import {
  BankingSessionResponseDto,
  BankingStartAuthDto,
  BankingStartAuthResponseDto,
  BankTransactionResponseDto,
  BankTxMatchCandidatesDto,
  BankTxSetCategoryDto,
  BankTxSetMatchDto,
} from 'src/dtos/banking.dto';
import { BankTxCategory, JobName } from 'src/enum';
import { BankTransaction, BankTransactionRepository } from 'src/repositories/bank-transaction.repository';
import { BankingSession, BankingSessionRepository } from 'src/repositories/banking-session.repository';
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
  ) {}

  @Post('auth/start')
  @Authenticated()
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
  async getLatestSession(): Promise<BankingSessionResponseDto | null> {
    const row = await this.sessionRepository.findLatest();
    return row ? toDto(row) : null;
  }

  /**
   * Admin "Sync now" — enqueue an immediate banking-sync job. We pass the
   * caller's IP through as PSU-IP-Address so Enable Banking marks the call
   * as user-online (exempt from the 4/day PSD2 background cap).
   */
  @Post('sync')
  @Authenticated()
  async sync(@Ip() ip: string): Promise<{ enqueued: true }> {
    await this.jobRepository.queue(JobName.BankingSyncAll, { psuIpAddress: ip });
    return { enqueued: true };
  }

  /** Recent bank_transaction rows. Drives the list panel on /banking. */
  @Get('transactions')
  @Authenticated()
  async listTransactions(): Promise<BankTransactionResponseDto[]> {
    const rows = await this.bankTransactionRepository.findRecent(50);
    return rows.map((row) => toBankTransactionDto(row));
  }

  /**
   * Candidates for manual link. Defaults to recent rows of each type when no
   * query is given; with a query, filters by the most useful identifier per
   * type (wise reference, invoice number, vendor name).
   */
  @Get('match-candidates')
  @Authenticated()
  async matchCandidates(@Query('q') q?: string): Promise<BankTxMatchCandidatesDto> {
    const candidates = await this.matcher.findMatchCandidates(q);
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
  async setCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BankTxSetCategoryDto,
  ): Promise<BankTransactionResponseDto> {
    const row = await this.bankTransactionRepository.setCategory(id, body.category as BankTxCategory | null);
    if (!row) {
      throw new NotFoundException();
    }
    return toBankTransactionDto(row);
  }

  /** Operator unlink — clears all match fields. */
  @Delete('transactions/:id/match')
  @Authenticated()
  async clearMatch(@Param('id', ParseUUIDPipe) id: string): Promise<BankTransactionResponseDto> {
    const row = await this.matcher.clearMatch(id);
    return toBankTransactionDto(row);
  }
}

function toBankTransactionDto(row: BankTransaction): BankTransactionResponseDto {
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
    matchedAt: row.matchedAt ? new Date(row.matchedAt).toISOString() : null,
    matchConfidence: row.matchConfidence,
    category: row.category,
  };
}

function toDto(row: BankingSession): BankingSessionResponseDto {
  return {
    id: row.id,
    status: row.status,
    aspspName: row.aspspName,
    aspspCountry: row.aspspCountry,
    psuType: row.psuType,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    lastSyncedAt: row.lastSyncedAt ? new Date(row.lastSyncedAt).toISOString() : null,
    accounts: ((row.accountsJson ?? []) as Array<{
      uid: string;
      iban?: string | null;
      currency: string;
      name?: string | null;
      product?: string | null;
    }>).map((a) => ({
      uid: a.uid,
      iban: a.iban ?? null,
      currency: a.currency,
      name: a.name ?? null,
      product: a.product ?? null,
    })),
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
