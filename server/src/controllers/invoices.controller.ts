import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { loadConfig } from 'src/config';
import { ApiQueryFromDto, Authenticated } from 'src/decorators';
import {
  InvoiceComposeDto,
  InvoiceComposeFromWiseDto,
  InvoiceComposeResponseDto,
  InvoiceResponseDto,
  ListInvoicesQueryDto,
  ListInvoicesResponseDto,
  WiseInvoicePrefillDto,
  mapInvoice,
} from 'src/dtos/invoice.dto';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { InvoiceComposerService, InvoiceLineInput } from 'src/services/invoice-composer.service';

@ApiTags('Invoices')
@Controller('/api/invoices')
export class InvoicesController {
  constructor(
    private readonly composer: InvoiceComposerService,
    private readonly invoiceRepository: InvoiceRepository,
  ) {}

  /** Paginated invoice list. Drives the /invoices list view. */
  @Get()
  @Authenticated()
  @ApiQueryFromDto(ListInvoicesQueryDto)
  async listInvoices(@Query() query: ListInvoicesQueryDto): Promise<ListInvoicesResponseDto> {
    const { items, total } = await this.invoiceRepository.findPaginated({
      year: query.year,
      status: query.status,
      offset: (query.page - 1) * query.limit,
      limit: query.limit,
    });
    return {
      items: items.map((row) => ({
        id: row.id,
        number: row.number,
        issuedAt: toIsoDate(row.issuedAt),
        clientId: row.clientId,
        clientName: row.clientName,
        currency: row.currency,
        totalMinor: String(row.totalMinor),
        eurTotalMinor: row.eurTotalMinor === null ? null : String(row.eurTotalMinor),
        btwRateBps: row.btwRateBps,
        btwMinor: row.btwMinor === null ? null : String(row.btwMinor),
        paperlessDocId: row.paperlessDocId,
        paid: row.matchedBankTxId !== null,
      })),
      total,
    };
  }

  @Get(':id')
  @Authenticated()
  async getInvoice(@Param('id', ParseUUIDPipe) id: string): Promise<InvoiceResponseDto> {
    const invoice = await this.invoiceRepository.findById(id);
    if (!invoice) {
      throw new NotFoundException();
    }
    return mapInvoice(invoice);
  }

  /**
   * Compose, issue, render, and archive an invoice in one shot. Returns the
   * persisted row + paperless metadata when the upload succeeded; the PDF
   * itself is on disk inside paperless and addressable via paperlessDocId.
   */
  @Post('compose')
  @Authenticated()
  async composeInvoice(@Body() dto: InvoiceComposeDto): Promise<InvoiceComposeResponseDto> {
    const result = await this.composer.composeAndIssue({
      clientId: dto.clientId,
      issuedAt: dto.issuedAt,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
      currency: dto.currency,
      eurTotalMinor: dto.eurTotalMinor,
      fxRate: dto.fxRate,
      btwRateBps: dto.btwRateBps,
      sourceEventId: dto.sourceEventId,
      lines: (dto.lines as InvoiceLineInput[]).map((line) => ({
        description: line.description,
        unitLabel: line.unitLabel,
        quantity: line.quantity,
        lineTotalMinor: line.lineTotalMinor,
      })),
    });
    return {
      invoice: mapInvoice(result.invoice),
    } as InvoiceComposeResponseDto;
  }

  /**
   * Prefill data for the "compose invoice from completed Wise transfer" form.
   * UI calls this before opening the composer to hydrate currency, amounts,
   * and a suggested client. Validates the transfer is invoiceable (outgoing,
   * outgoing_payment_sent, not already invoiced) so the UI doesn't surface
   * the action for transfers that wouldn't accept a compose.
   */
  @Get('wise-prefill/:wiseTransferId')
  @Authenticated()
  async getWisePrefill(@Param('wiseTransferId', ParseUUIDPipe) wiseTransferId: string): Promise<WiseInvoicePrefillDto> {
    const prefill = await this.composer.prefillFromWise(wiseTransferId);
    return {
      wiseTransferId: prefill.wiseTransferId,
      currency: prefill.currency,
      totalMinor: String(prefill.totalMinor),
      eurTotalMinor: String(prefill.eurTotalMinor),
      ourReference: prefill.ourReference,
      suggestedClientId: prefill.suggestedClientId,
    };
  }

  /**
   * Compose an invoice from a completed outbound Wise transfer. Currency +
   * amounts come from the transfer (user doesn't enter FX); the body
   * supplies client + period + line splits.
   */
  @Post('compose-from-wise/:wiseTransferId')
  @Authenticated()
  async composeInvoiceFromWise(
    @Param('wiseTransferId', ParseUUIDPipe) wiseTransferId: string,
    @Body() dto: InvoiceComposeFromWiseDto,
  ): Promise<InvoiceComposeResponseDto> {
    const result = await this.composer.composeFromWise({
      wiseTransferId,
      clientId: dto.clientId,
      issuedAt: dto.issuedAt,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
      lines: (dto.lines as InvoiceLineInput[]).map((line) => ({
        description: line.description,
        unitLabel: line.unitLabel,
        quantity: line.quantity,
        lineTotalMinor: line.lineTotalMinor,
      })),
    });
    return {
      invoice: mapInvoice(result.invoice),
    } as InvoiceComposeResponseDto;
  }

  /**
   * Re-render an issued invoice's PDF on demand. Same template + data the
   * compose flow would have used; useful for downloading the file before
   * sending it manually, or when paperless wasn't reachable at compose time.
   */
  @Get(':id/pdf')
  @Authenticated()
  async getInvoicePdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const invoice = await this.invoiceRepository.findById(id);
    if (!invoice) {
      throw new NotFoundException();
    }
    const { filename, pdf } = await this.composer.renderInvoicePdf(id);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.setHeader('content-length', String(pdf.byteLength));
    res.end(pdf);
  }

  /**
   * Redirect to the paperless document UI for this invoice. 404 when the
   * invoice was never archived (paperless was unreachable at compose time
   * and the retry job hasn't completed yet).
   */
  @Get(':id/paperless')
  @Authenticated()
  async paperlessRedirect(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const invoice = await this.invoiceRepository.findById(id);
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    if (!invoice.paperlessDocId) {
      throw new NotFoundException('Invoice not yet archived in paperless');
    }
    const baseUrl = loadConfig().paperless.baseUrl;
    if (!baseUrl) {
      throw new NotFoundException('Paperless not configured');
    }
    res.redirect(302, `${baseUrl.replace(/\/$/, '')}/documents/${invoice.paperlessDocId}/`);
  }
}

function toIsoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
