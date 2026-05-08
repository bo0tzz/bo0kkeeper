import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Authenticated } from 'src/decorators';
import { InvoiceComposeDto, InvoiceComposeResponseDto, InvoiceResponseDto, mapInvoice } from 'src/dtos/invoice.dto';
import { InvoiceRepository } from 'src/repositories/invoice.repository';
import { InvoiceComposerService, InvoiceLineInput } from 'src/services/invoice-composer.service';

@ApiTags('Invoices')
@Controller('/api/invoices')
export class InvoicesController {
  constructor(
    private readonly composer: InvoiceComposerService,
    private readonly invoiceRepository: InvoiceRepository,
  ) {}

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
      paperlessTaskId: result.paperlessTaskId,
      paperlessDocId: result.paperlessDocId,
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
}
