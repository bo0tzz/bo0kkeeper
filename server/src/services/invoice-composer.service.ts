import { Injectable, Logger } from '@nestjs/common';
import { ClientClass } from 'src/enum';
import { Client, ClientRepository } from 'src/repositories/client.repository';
import { InvoiceRepository, InvoiceWithLines } from 'src/repositories/invoice.repository';
import { PaperlessService } from 'src/services/paperless.service';
import { RenderService } from 'src/services/render.service';

export type InvoiceLineInput = {
  description: string;
  unitLabel?: string;
  quantity?: string;
  /** Line total in the invoice's primary currency (minor units, e.g. USD cents). */
  lineTotalMinor: bigint;
};

export type InvoiceCompositionInput = {
  clientId: string;
  /** Defaults to today; usually the period end (e.g. 15th / end-of-month for OverseasClientCo). */
  issuedAt: Date;
  periodStart?: Date;
  periodEnd?: Date;
  /** Primary currency. USD for OverseasClientCo non-EU; EUR for domestic. */
  currency: string;
  /**
   * For Non-EU bilingual invoices: the EUR equivalent of the total at the FX
   * rate that landed (from Wise outgoing transfer). Null otherwise.
   */
  eurTotalMinor?: bigint;
  fxRate?: string;
  /** Basis points (2100 = 21.00%). Null for `non_eu` clients. */
  btwRateBps?: number;
  /** Optional source event id (Wise outgoing transfer that triggered the invoice). */
  sourceEventId?: string;
  lines: InvoiceLineInput[];
};

export type ComposeResult = {
  invoice: InvoiceWithLines;
  pdf: Buffer;
  /** Paperless task id, returned when upload was attempted. */
  paperlessTaskId?: string;
  /** Final paperless document id, returned when polling completed. */
  paperlessDocId?: string;
};

const TEMPLATE_BY_CLASS: Record<ClientClass, 'overseas-non-eu' | 'domestic'> = {
  [ClientClass.NonEu]: 'overseas-non-eu',
  [ClientClass.Domestic]: 'domestic',
  [ClientClass.Eu]: 'domestic',
  [ClientClass.EuReverseCharge]: 'domestic',
};

/**
 * Orchestrates "compose → issue → render → archive."
 *
 *   1. Validates input and resolves the client.
 *   2. Issues the invoice (allocates number + persists invoice + lines).
 *   3. Renders the PDF via Typst.
 *   4. Uploads to paperless (when configured) and stores the doc id.
 *
 * Steps 3/4 are best-effort wrt paperless availability — failure to upload
 * shouldn't lose the issued invoice (the row already exists). Paperless
 * polling can retry later via a job.
 */
@Injectable()
export class InvoiceComposerService {
  private readonly logger = new Logger(InvoiceComposerService.name);

  constructor(
    private readonly clientRepository: ClientRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly renderService: RenderService,
    private readonly paperlessService: PaperlessService,
  ) {}

  async composeAndIssue(input: InvoiceCompositionInput): Promise<ComposeResult> {
    const client = await this.clientRepository.findById(input.clientId);
    if (!client) {
      throw new Error(`Client not found: ${input.clientId}`);
    }

    const totalMinor = input.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0n);

    const issued = await this.invoiceRepository.issue({
      year: input.issuedAt.getUTCFullYear(),
      invoice: {
        clientId: client.id,
        issuedAt: input.issuedAt,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        currency: input.currency,
        totalMinor,
        eurTotalMinor: input.eurTotalMinor ?? null,
        fxRate: input.fxRate ?? null,
        btwRateBps: input.btwRateBps ?? null,
        btwMinor: input.btwRateBps ? (totalMinor * BigInt(input.btwRateBps)) / 10_000n : null,
        sourceEventId: input.sourceEventId ?? null,
      },
      lines: input.lines.map((line, index) => ({
        ordinal: index,
        description: line.description,
        unitLabel: line.unitLabel ?? null,
        quantity: line.quantity ?? null,
        lineTotalMinor: line.lineTotalMinor,
      })),
    });

    const template = TEMPLATE_BY_CLASS[client.class];
    const data = buildTemplateData(client, issued);
    const pdf = await this.renderService.render({ template, data });

    let paperlessTaskId: string | undefined;
    let paperlessDocId: string | undefined;
    try {
      const upload = await this.paperlessService.uploadDocument({
        file: pdf,
        filename: `${issued.number.replaceAll('/', '-')}.pdf`,
        title: `${client.name} ${issued.number}`,
        created: input.issuedAt.toISOString().slice(0, 10),
      });
      paperlessTaskId = upload.taskId;
      paperlessDocId = await this.paperlessService.waitForDocumentId(upload.taskId);
      await this.invoiceRepository.setPaperlessDocId(issued.id, paperlessDocId);
    } catch (error) {
      this.logger.error(`Paperless archive failed for invoice ${issued.number}: ${(error as Error).message}`);
    }

    return { invoice: issued, pdf, paperlessTaskId, paperlessDocId };
  }
}

function formatMinor(minor: bigint): string {
  // Format bigint cents as a decimal string with two fractional digits.
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const major = abs / 100n;
  const cents = abs % 100n;
  const fractional = cents.toString().padStart(2, '0');
  return `${negative ? '-' : ''}${major.toString()}.${fractional}`;
}

function eurFromMinor(minor: bigint, fxRate: string | null): string {
  if (fxRate === null) {
    return formatMinor(minor);
  }
  // Multiply minor by fxRate as a decimal — string math to avoid float drift.
  // Naive approach: convert to number; precision is fine for invoice scale.
  const eur = (Number(minor) / 100) * Number.parseFloat(fxRate);
  return eur.toFixed(2);
}

function buildTemplateData(client: Client, invoice: InvoiceWithLines): Record<string, unknown> {
  const issuerAddress = (
    client.tradeName === 'it_services'
      ? {
          name: 'de Willigen IT Services',
        }
      : {
          name: 'de Willigen 3D',
        }
  ) as Record<string, string>;

  return {
    issuer: {
      ...issuerAddress,
      addressLine1: 'Example Street 1',
      postalCode: '1234 AB',
      city: 'Exampletown',
      country: 'The Netherlands',
      kvk: 'CONFIGURE',
      vatId: 'CONFIGURE',
    },
    client: {
      name: client.name,
      addressLine1: (client.address as Record<string, string>)['line1'] ?? '',
      city: (client.address as Record<string, string>)['city'] ?? '',
    },
    invoice: {
      number: invoice.number,
      dateFormatted: formatDate(invoice.issuedAt),
      totalUsd: formatMinor(BigInt(invoice.totalMinor as unknown as string)),
      totalEur:
        invoice.eurTotalMinor === null || invoice.eurTotalMinor === undefined
          ? formatMinor(BigInt(invoice.totalMinor as unknown as string))
          : formatMinor(BigInt(invoice.eurTotalMinor as unknown as string)),
    },
    lines: invoice.lines.map((line) => ({
      description: line.description,
      usdAmount: formatMinor(BigInt(line.lineTotalMinor as unknown as string)),
      eurAmount: eurFromMinor(BigInt(line.lineTotalMinor as unknown as string), invoice.fxRate),
    })),
  };
}

function formatDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
