import { BadRequestException, Body, Controller, Get, Ip, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Authenticated } from 'src/decorators';
import {
  BankingSessionResponseDto,
  BankingStartAuthDto,
  BankingStartAuthResponseDto,
} from 'src/dtos/banking.dto';
import { JobName } from 'src/enum';
import { BankingSession, BankingSessionRepository } from 'src/repositories/banking-session.repository';
import { JobRepository } from 'src/repositories/job.repository';
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
