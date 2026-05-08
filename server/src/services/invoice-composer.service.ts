import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Config, loadConfig } from 'src/config';
import { OnJob } from 'src/decorators';
import { ClientClass, JobName, QueueName, TradeName } from 'src/enum';
import { Client, ClientRepository } from 'src/repositories/client.repository';
import { InvoiceRepository, InvoiceWithLines } from 'src/repositories/invoice.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { PaperlessService } from 'src/services/paperless.service';
import { RenderService } from 'src/services/render.service';
import { JobOf } from 'src/types';

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
  /** Optional per-invoice payment link (e.g. SNS bank betaalverzoek URL). */
  paymentLink?: string;
  lines: InvoiceLineInput[];
};

export type ComposeResult = {
  invoice: InvoiceWithLines;
  pdf: Buffer;
};

/** Single template covers every client class; the data shape carries the variant. */
const INVOICE_TEMPLATE = 'invoice' as const;

/**
 * Orchestrates invoice composition.
 *
 *   1. Validates input and resolves the client.
 *   2. Issues the invoice (allocates number + persists invoice + lines).
 *   3. Renders the PDF via Typst (returned to the caller — eg the compose
 *      response, or the on-demand download endpoint).
 *   4. Enqueues an `ArchiveInvoiceToPaperless` job to push the PDF into
 *      paperless. The job re-renders from the row each time it runs, so
 *      retries are safe and the invoice is fully reproducible from DB
 *      state alone.
 */
@Injectable()
export class InvoiceComposerService {
  private readonly logger = new Logger(InvoiceComposerService.name);

  constructor(
    private readonly clientRepository: ClientRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly renderService: RenderService,
    private readonly paperlessService: PaperlessService,
    private readonly jobRepository: JobRepository,
  ) {}

  /**
   * Re-render the invoice from its persisted state and push to paperless.
   * Idempotent: if the invoice already has a paperlessDocId, the upload is
   * skipped and the job succeeds. pg-boss will retry on transient failures
   * (paperless down, network blip).
   */
  @OnJob({ name: JobName.ArchiveInvoiceToPaperless, queue: QueueName.Default })
  async handleArchiveInvoiceToPaperless({ invoiceId }: JobOf<JobName.ArchiveInvoiceToPaperless>): Promise<void> {
    const invoice = await this.invoiceRepository.findById(invoiceId);
    if (!invoice) {
      throw new NotFoundException(`Invoice not found: ${invoiceId}`);
    }
    if (invoice.paperlessDocId) {
      this.logger.log(`invoice ${invoice.number} already archived (paperlessDocId=${invoice.paperlessDocId})`);
      return;
    }
    const client = await this.clientRepository.findById(invoice.clientId);
    if (!client) {
      throw new Error(`Client not found for invoice ${invoice.number}: ${invoice.clientId}`);
    }
    const data = buildInvoiceData(client, invoice);
    const pdf = await this.renderService.render({ template: INVOICE_TEMPLATE, data });

    const issuedAt = invoice.issuedAt instanceof Date ? invoice.issuedAt : new Date(invoice.issuedAt);
    const upload = await this.paperlessService.uploadDocument({
      file: pdf,
      filename: `${invoice.number.replaceAll('/', '-')}.pdf`,
      title: `${client.name} ${invoice.number}`,
      created: issuedAt.toISOString().slice(0, 10),
    });
    const docId = await this.paperlessService.waitForDocumentId(upload.taskId);
    await this.invoiceRepository.setPaperlessDocId(invoice.id, docId);
    this.logger.log(`invoice ${invoice.number} archived as paperless doc ${docId}`);
  }

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
        paymentLink: input.paymentLink ?? null,
      },
      lines: input.lines.map((line, index) => ({
        ordinal: index,
        description: line.description,
        unitLabel: line.unitLabel ?? null,
        quantity: line.quantity ?? null,
        lineTotalMinor: line.lineTotalMinor,
      })),
    });

    const data = buildInvoiceData(client, issued);
    const pdf = await this.renderService.render({ template: INVOICE_TEMPLATE, data });

    // Paperless archive runs async via pg-boss. Keeps compose fast, retries
    // automatically if paperless is unreachable, and avoids a "PDF lost in
    // memory" failure mode — the invoice is fully reproducible from the row,
    // so the job re-renders before each upload attempt.
    await this.jobRepository.queue(JobName.ArchiveInvoiceToPaperless, { invoiceId: issued.id });

    return { invoice: issued, pdf };
  }

  /**
   * Re-render an issued invoice to PDF using its stored fields. Used by the
   * download endpoint so the user can grab the same file the system pushed
   * to paperless (or would have, if paperless wasn't reachable at compose
   * time).
   */
  async renderInvoicePdf(invoiceId: string): Promise<{ filename: string; pdf: Buffer }> {
    const invoice = await this.invoiceRepository.findById(invoiceId);
    if (!invoice) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }
    const client = await this.clientRepository.findById(invoice.clientId);
    if (!client) {
      throw new Error(`Client not found for invoice ${invoice.number}: ${invoice.clientId}`);
    }
    const data = buildInvoiceData(client, invoice);
    const pdf = await this.renderService.render({ template: INVOICE_TEMPLATE, data });
    return {
      filename: `${invoice.number.replaceAll('/', '-')}.pdf`,
      pdf,
    };
  }
}

/** Period decimals, e.g. 4155.12 — used for OverseasClientCo non-EU invoices. */
function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const major = abs / 100n;
  const cents = abs % 100n;
  const fractional = cents.toString().padStart(2, '0');
  return `${negative ? '-' : ''}${major.toString()}.${fractional}`;
}

/** Same value but drop ".00" for whole amounts: "4791" not "4791.00". */
function formatMinorWhole(minor: bigint): string {
  if (minor % 100n === 0n) {
    const major = minor / 100n;
    return major.toString();
  }
  return formatMinor(minor);
}

/**
 * Dutch number format used on domestic invoices: "165,-" for whole amounts,
 * "32,50" for fractional. Matches the user's existing Acme Studio invoices.
 */
function formatMinorDutch(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const major = abs / 100n;
  const cents = abs % 100n;
  const sign = negative ? '-' : '';
  if (cents === 0n) {
    return `${sign}${major.toString()},-`;
  }
  return `${sign}${major.toString()},${cents.toString().padStart(2, '0')}`;
}

function eurFromMinor(minor: bigint, fxRate: string | null): string {
  if (fxRate === null) {
    return formatMinor(minor);
  }
  // Multiply minor by fxRate as a decimal — string math to avoid float drift.
  const eur = (Number(minor) / 100) * Number.parseFloat(fxRate);
  return eur.toFixed(2);
}

function buildIssuer(client: Client, issuer: Config['issuer']): Record<string, string> {
  const name = client.tradeName === TradeName.ItServices ? 'de Willigen IT Services' : 'de Willigen 3D';
  return {
    name,
    addressLine1: issuer.addressLine1,
    postalCode: issuer.postalCode,
    city: issuer.city,
    country: issuer.country,
    kvk: issuer.kvk,
    vatId: issuer.vatId,
  };
}

function buildClientBlock(client: Client): Record<string, string> {
  return {
    name: client.name,
    addressLine1: (client.address as Record<string, string>)['line1'] ?? '',
    city: (client.address as Record<string, string>)['city'] ?? '',
  };
}

/**
 * Format a date as "March 15, 2026" — month name in English, US convention.
 * Matches the existing OverseasClientCo invoice layout.
 */
function formatDateLong(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Format a date as "5 March 2026" — day-month-year, no comma. Matches the
 * existing Acme Studio (domestic) invoice layout.
 */
function formatDateDutch(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Build the data object handed to `invoice.typ`. The shape is uniform across
 * client classes; the template branches on `invoice.class`. Per-class
 * specifics:
 *
 *   - non_eu: USD primary with EUR-equivalent in parens (or EUR-only if the
 *     invoice was issued in EUR). No BTW, no payment block. "Per email:"
 *     recipient label, US date format.
 *   - eu_reverse_charge: similar simple amount column, EUR currency, no BTW.
 *     IBAN payment block; "Via email:" recipient label, Dutch date.
 *   - domestic / eu (BTW-charged): full Dutch BTW breakdown (subtotal /
 *     BTW / total) with per-line unit + quantity + total, IBAN payment.
 */
function buildInvoiceData(client: Client, invoice: InvoiceWithLines): Record<string, unknown> {
  const issuer = loadConfig().issuer;
  const totalMinor = BigInt(invoice.totalMinor as unknown as string);
  const isNonEu = client.class === ClientClass.NonEu;
  const isReverseCharge = client.class === ClientClass.EuReverseCharge;
  const hasBtw = !(isNonEu || isReverseCharge);

  const baseInvoice: Record<string, unknown> = {
    class: client.class,
    currency: invoice.currency,
    number: invoice.number,
    dateFormatted: isNonEu ? formatDateLong(invoice.issuedAt) : formatDateDutch(invoice.issuedAt),
  };

  let invoiceFields: Record<string, unknown>;
  let lines: Record<string, unknown>[];

  if (hasBtw) {
    const btwMinor =
      invoice.btwMinor === null || invoice.btwMinor === undefined ? 0n : BigInt(invoice.btwMinor as unknown as string);
    const subtotalMinor = totalMinor - btwMinor;
    const btwRatePercent =
      invoice.btwRateBps === null || invoice.btwRateBps === undefined
        ? '0%'
        : `${(invoice.btwRateBps / 100).toFixed(0)}%`;
    invoiceFields = {
      ...baseInvoice,
      subtotal: formatMinorDutch(subtotalMinor),
      btwRate: btwRatePercent,
      btwAmount: formatMinorDutch(btwMinor),
      total: formatMinorDutch(totalMinor),
    };
    lines = invoice.lines.map((line) => ({
      description: line.description,
      unit: line.unitLabel ?? '',
      quantity: line.quantity ?? '',
      total: formatMinorDutch(BigInt(line.lineTotalMinor as unknown as string)),
    }));
  } else {
    const eurTotalMinor =
      invoice.eurTotalMinor === null || invoice.eurTotalMinor === undefined
        ? totalMinor
        : BigInt(invoice.eurTotalMinor as unknown as string);
    const formatPrimary = (minor: bigint) =>
      invoice.currency === 'USD' ? formatMinorWhole(minor) : formatMinor(minor);
    invoiceFields = {
      ...baseInvoice,
      totalLine: {
        usdAmount: formatPrimary(totalMinor),
        eurAmount: formatMinor(eurTotalMinor),
      },
    };
    lines = invoice.lines.map((line) => ({
      description: line.description,
      usdAmount: formatPrimary(BigInt(line.lineTotalMinor as unknown as string)),
      eurAmount: eurFromMinor(BigInt(line.lineTotalMinor as unknown as string), invoice.fxRate),
    }));
  }

  const data: Record<string, unknown> = {
    issuer: buildIssuer(client, issuer),
    client: buildClientBlock(client),
    invoice: invoiceFields,
    lines,
  };

  // EUR-paid invoices include the IBAN payment block. Non-EU (USD-paid via
  // Wise) doesn't need it on the invoice itself.
  if (!isNonEu) {
    data.payment = {
      iban: issuer.iban,
      name: client.tradeName === TradeName.ItServices ? 'de Willigen IT Services' : 'de Willigen 3D',
      ...(invoice.paymentLink ? { paymentLink: invoice.paymentLink } : {}),
    };
  }

  return data;
}
