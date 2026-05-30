import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnJob } from 'src/decorators';
import { ClientClass, EventSource, JobName, QueueName, TradeName } from 'src/enum';
import { Client, ClientRepository } from 'src/repositories/client.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { InvoiceRepository, InvoiceWithLines } from 'src/repositories/invoice.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { PaperlessRepository } from 'src/repositories/paperless.repository';
import { TypstRepository } from 'src/repositories/typst.repository';
import { SettingsService } from 'src/services/settings.service';
import { JobOf } from 'src/types';
import { toDate } from 'src/utils/date';

export type InvoiceLineInput = {
  description: string;
  unitLabel?: string;
  quantity?: string;
  /** Line total in the invoice's primary currency (minor units, e.g. USD cents). */
  lineTotalMinor: bigint;
};

export type InvoiceCompositionInput = {
  clientId: string;
  /** Defaults to today; usually the period end (e.g. 15th / end-of-month for non-EU clients). */
  issuedAt: Date;
  periodStart?: Date;
  periodEnd?: Date;
  /** Primary currency. USD for non-EU; EUR for domestic. */
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
    private readonly renderService: TypstRepository,
    private readonly paperlessService: PaperlessRepository,
    private readonly jobRepository: JobRepository,
    private readonly eventRepository: EventRepository,
    private readonly settingsService: SettingsService,
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
    const data = buildInvoiceData(client, invoice, await this.settingsService.getIssuer());
    const pdf = await this.renderService.render({ template: INVOICE_TEMPLATE, data });

    // Resolve outgoing-invoice tag NAMES → IDs at upload time (auto-creates
    // any missing). Keeping settings as names lets the same config work
    // against dev paperless and the user's real instance, where tag IDs
    // differ.
    const outgoingInvoiceTags = await this.settingsService.getPaperlessOutgoingInvoiceTags();
    const tagIds =
      outgoingInvoiceTags.length === 0 ? undefined : await this.paperlessService.resolveTagIds(outgoingInvoiceTags);

    const issuedAt = toDate(invoice.issuedAt);
    const upload = await this.paperlessService.uploadDocument({
      file: pdf,
      filename: `${invoice.number.replaceAll('/', '-')}.pdf`,
      title: `${client.name} ${invoice.number}`,
      created: issuedAt.toISOString().slice(0, 10),
      tagIds,
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

    // Line amounts are net (excl-BTW); they sum to the subtotal. BTW is then
    // charged on top and the grand total is subtotal + BTW — the gross amount
    // the client pays and the figure the bank-matcher reconciles against the
    // deposit. (`totalMinor` is the invoice's primary money = gross.)
    //
    // Only domestic + standard-EU clients carry BTW. Non-EU (out of scope) and
    // EU reverse-charge invoices must never record BTW even if a rate is passed
    // — the compose form's BTW field defaults to 21 and isn't class-aware, so
    // guard server-side. The rendered PDF already omits BTW for these classes;
    // recording it anyway would inflate the aggregator's collected-BTW total.
    const chargesBtw = client.class === ClientClass.Domestic || client.class === ClientClass.Eu;
    const btwRateBps = chargesBtw ? (input.btwRateBps ?? null) : null;
    const subtotalMinor = input.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0n);
    const btwMinor = btwRateBps ? btwOnNet(subtotalMinor, btwRateBps) : null;
    const totalMinor = subtotalMinor + (btwMinor ?? 0n);

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
        btwRateBps,
        btwMinor,
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

    const data = buildInvoiceData(client, issued, await this.settingsService.getIssuer());
    const pdf = await this.renderService.render({ template: INVOICE_TEMPLATE, data });

    // Paperless archive runs async via pg-boss. Keeps compose fast, retries
    // automatically if paperless is unreachable, and avoids a "PDF lost in
    // memory" failure mode — the invoice is fully reproducible from the row,
    // so the job re-renders before each upload attempt.
    await this.jobRepository.queue(JobName.ArchiveInvoiceToPaperless, { invoiceId: issued.id });

    await this.eventRepository.recordAction({
      source: EventSource.Manual,
      eventType: 'invoice.issued',
      payload: {
        invoiceId: issued.id,
        number: issued.number,
        clientId: client.id,
        clientName: client.name,
        currency: issued.currency,
        totalMinor: String(issued.totalMinor),
      },
    });

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
    const data = buildInvoiceData(client, invoice, await this.settingsService.getIssuer());
    const pdf = await this.renderService.render({ template: INVOICE_TEMPLATE, data });
    return {
      filename: `${invoice.number.replaceAll('/', '-')}.pdf`,
      pdf,
    };
  }
}

/** Period decimals, e.g. 4155.12 — used for non-EU invoices. */
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
 * "32,50" for fractional.
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

type IssuerInfo = {
  kvk: string;
  vatId: string;
  addressLine1: string;
  postalCode: string;
  city: string;
  country: string;
  iban: string;
};

function buildIssuer(client: Client, issuer: IssuerInfo): Record<string, string> {
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
 */
function formatDateLong(date: Date | string): string {
  const d = toDate(date);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Format a date as "5 March 2026" — day-month-year, no comma.
 */
function formatDateDutch(date: Date | string): string {
  const d = toDate(date);
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Build the data object handed to `invoice.typ`. The composer fully describes
 * the line-items table (headers + per-row cells) and the totals section, so
 * the template is a generic renderer rather than a class-specific switch.
 *
 * Per-class differences:
 *   - non_eu / reverse_charge: 2-column table (description + amount), single
 *     "Amount" total row. Non-EU shows USD with EUR equivalent inline; no
 *     payment block, "NO VAT because non EU" footer (or reverse-charge note).
 *   - domestic / eu (BTW-charged): 4-column table (description / unit /
 *     amount / total) and a 3-line summary (subtotal, BTW, total). IBAN
 *     payment block.
 */
/**
 * BTW (Dutch VAT) charged on top of a net subtotal, in minor units.
 *
 * Composer line amounts are net (excl-BTW); they sum to the subtotal, and BTW
 * is `subtotal × rate` added on top (Total = subtotal + BTW). Rounded half-up
 * to the nearest cent.
 */
function btwOnNet(netMinor: bigint, rateBps: number): bigint {
  return (netMinor * BigInt(rateBps) + 5000n) / 10_000n;
}

function buildInvoiceData(client: Client, invoice: InvoiceWithLines, issuer: IssuerInfo): Record<string, unknown> {
  const totalMinor = BigInt(invoice.totalMinor as unknown as string);
  const isNonEu = client.class === ClientClass.NonEu;
  const isReverseCharge = client.class === ClientClass.EuReverseCharge;
  const hasBtw = !(isNonEu || isReverseCharge);

  const data: Record<string, unknown> = {
    issuer: buildIssuer(client, issuer),
    client: buildClientBlock(client),
    invoice: {
      number: invoice.number,
      dateFormatted: isNonEu ? formatDateLong(invoice.issuedAt) : formatDateDutch(invoice.issuedAt),
    },
    table: hasBtw ? domesticTable(invoice) : nonEuTable(invoice),
    summary: hasBtw ? domesticSummary(invoice, totalMinor) : nonEuSummary(invoice, totalMinor),
  };

  if (isNonEu) {
    data.footer = 'NO VAT because non EU';
  } else if (isReverseCharge) {
    data.footer = 'VAT reverse-charged (intra-EU services, customer accounts for VAT)';
  }

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

type Align = 'left' | 'right';
type Table = { headers: string[]; aligns: Align[]; rows: string[][] };
type SummaryRow = { label: string; value: string; emphasised?: boolean };

function domesticTable(invoice: InvoiceWithLines): Table {
  return {
    headers: ['Description', 'Unit', 'Amount', 'Total'],
    aligns: ['left', 'right', 'right', 'right'],
    rows: invoice.lines.map((line) => [
      line.description,
      line.unitLabel ?? '',
      line.quantity ?? '',
      `€ ${formatMinorDutch(BigInt(line.lineTotalMinor as unknown as string))}`,
    ]),
  };
}

function nonEuTable(invoice: InvoiceWithLines): Table {
  const formatPrimary = (minor: bigint) => (invoice.currency === 'USD' ? formatMinorWhole(minor) : formatMinor(minor));
  return {
    headers: ['Description', 'Amount'],
    aligns: ['left', 'right'],
    rows: invoice.lines.map((line) => {
      const lineMinor = BigInt(line.lineTotalMinor as unknown as string);
      return [
        line.description,
        formatLineAmount(invoice, formatPrimary(lineMinor), eurFromMinor(lineMinor, invoice.fxRate)),
      ];
    }),
  };
}

function domesticSummary(invoice: InvoiceWithLines, totalMinor: bigint): SummaryRow[] {
  const btwMinor =
    invoice.btwMinor === null || invoice.btwMinor === undefined ? 0n : BigInt(invoice.btwMinor as unknown as string);
  const subtotalMinor = totalMinor - btwMinor;
  const btwRatePercent =
    invoice.btwRateBps === null || invoice.btwRateBps === undefined
      ? '0%'
      : `${(invoice.btwRateBps / 100).toFixed(0)}%`;
  return [
    { label: 'Subtotal', value: `€ ${formatMinorDutch(subtotalMinor)}` },
    { label: `BTW (${btwRatePercent})`, value: `€ ${formatMinorDutch(btwMinor)}` },
    { label: 'Total', value: `€ ${formatMinorDutch(totalMinor)}`, emphasised: true },
  ];
}

function nonEuSummary(invoice: InvoiceWithLines, totalMinor: bigint): SummaryRow[] {
  const eurTotalMinor =
    invoice.eurTotalMinor === null || invoice.eurTotalMinor === undefined
      ? totalMinor
      : BigInt(invoice.eurTotalMinor as unknown as string);
  const formatPrimary = invoice.currency === 'USD' ? formatMinorWhole : formatMinor;
  return [
    {
      label: 'Amount',
      value: formatLineAmount(invoice, formatPrimary(totalMinor), formatMinor(eurTotalMinor)),
      emphasised: true,
    },
  ];
}

/**
 * Currency-aware amount string for non-EU invoices. USD shows "$ X (€ Y)";
 * EUR-only (e.g. reimbursements) just shows "€ Y".
 */
function formatLineAmount(invoice: InvoiceWithLines, primary: string, eur: string): string {
  if (invoice.currency === 'USD') {
    return `$ ${primary} (€ ${eur})`;
  }
  return `€ ${eur}`;
}
