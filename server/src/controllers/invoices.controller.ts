import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
}
