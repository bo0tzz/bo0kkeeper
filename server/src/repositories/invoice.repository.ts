import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';
import { InvoiceLineTable } from 'src/schema/tables/invoice-line.table';
import { InvoiceTable } from 'src/schema/tables/invoice.table';

export type Invoice = Selectable<InvoiceTable>;
export type InvoiceLine = Selectable<InvoiceLineTable>;
export type NewInvoice = Insertable<InvoiceTable>;
export type NewInvoiceLine = Omit<Insertable<InvoiceLineTable>, 'invoiceId'>;

export type InvoiceWithLines = Invoice & { lines: InvoiceLine[] };

@Injectable()
export class InvoiceRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async findById(id: string): Promise<InvoiceWithLines | undefined> {
    const invoice = (await this.db.selectFrom('invoice').selectAll().where('id', '=', id).executeTakeFirst()) as
      | Invoice
      | undefined;
    if (!invoice) {
      return undefined;
    }
    const lines = (await this.db
      .selectFrom('invoice_line')
      .selectAll()
      .where('invoiceId', '=', id)
      .orderBy('ordinal', 'asc')
      .execute()) as InvoiceLine[];
    return { ...invoice, lines };
  }

  async findByNumber(number: string): Promise<Invoice | undefined> {
    return (await this.db.selectFrom('invoice').selectAll().where('number', '=', number).executeTakeFirst()) as
      | Invoice
      | undefined;
  }

  /**
   * Lookup an invoice by its paperless doc id (we set this after the
   * outgoing-invoice archive job lands the PDF in paperless). Used by the
   * expense-ingestion guard so a doc we generated doesn't loop back in as
   * an inbound expense.
   */
  async findByPaperlessDocId(paperlessDocId: string): Promise<Invoice | undefined> {
    return (await this.db
      .selectFrom('invoice')
      .selectAll()
      .where('paperlessDocId', '=', paperlessDocId)
      .executeTakeFirst()) as Invoice | undefined;
  }

  /**
   * Lookup the invoice composed from a given outbound Wise transfer.
   * Returns undefined when none has been composed yet — drives the
   * "Compose invoice" UI affordance + idempotency on composeFromWise.
   */
  async findByWiseTransferId(wiseTransferId: string): Promise<Invoice | undefined> {
    return (await this.db
      .selectFrom('invoice')
      .selectAll()
      .where('wiseTransferId', '=', wiseTransferId)
      .executeTakeFirst()) as Invoice | undefined;
  }

  /**
   * Issue a new invoice atomically: allocate the next number for the year,
   * persist the invoice + line rows, return the assembled aggregate.
   */
  async issue(input: {
    invoice: Omit<NewInvoice, 'number'>;
    lines: NewInvoiceLine[];
    year: number;
  }): Promise<InvoiceWithLines> {
    return this.db.transaction().execute(async (trx: Transaction<DB>) => {
      const number = await allocateInvoiceNumber(trx, input.year);
      const inserted = (await trx
        .insertInto('invoice')
        .values({ ...input.invoice, number })
        .returningAll()
        .executeTakeFirstOrThrow()) as Invoice;

      let lines: InvoiceLine[] = [];
      if (input.lines.length > 0) {
        lines = (await trx
          .insertInto('invoice_line')
          .values(
            input.lines.map((line, index) => ({ ...line, invoiceId: inserted.id, ordinal: line.ordinal ?? index })),
          )
          .returningAll()
          .execute()) as InvoiceLine[];
      }

      return { ...inserted, lines };
    });
  }

  /**
   * Paginated list with optional year + status filters. Status is derived
   * from the bank_transaction left-join — `paid` ⇒ a row matched this
   * invoice, `open` ⇒ none. Returns the page slice plus the unsliced total
   * so the UI can size the pager without a second round trip. Newest
   * issuedAt first (ties broken by number desc).
   */
  async findPaginated(input: { year?: number; status?: 'open' | 'paid'; offset: number; limit: number }): Promise<{
    items: Array<Invoice & { clientName: string | null; matchedBankTxId: string | null }>;
    total: number;
  }> {
    let query = this.db
      .selectFrom('invoice')
      .innerJoin('client', 'client.id', 'invoice.clientId')
      .leftJoin('bank_transaction', 'bank_transaction.matchedInvoiceId', 'invoice.id');
    if (input.year !== undefined) {
      const start = new Date(Date.UTC(input.year, 0, 1));
      const end = new Date(Date.UTC(input.year + 1, 0, 1));
      query = query.where('invoice.issuedAt', '>=', start).where('invoice.issuedAt', '<', end);
    }
    if (input.status === 'paid') {
      query = query.where('bank_transaction.id', 'is not', null);
    } else if (input.status === 'open') {
      query = query.where('bank_transaction.id', 'is', null);
    }

    const totalRow = (await query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst()) as
      | { count: string }
      | undefined;
    const total = Number(totalRow?.count ?? 0);

    const items = (await query
      .selectAll('invoice')
      .select(['client.name as clientName', 'bank_transaction.id as matchedBankTxId'])
      .orderBy('invoice.issuedAt', 'desc')
      .orderBy('invoice.number', 'desc')
      .limit(input.limit)
      .offset(input.offset)
      .execute()) as Array<Invoice & { clientName: string | null; matchedBankTxId: string | null }>;

    return { items, total };
  }

  /**
   * Bulk lookup of invoice numbers keyed by id. Used by the /transactions
   * unified view to label matched bank rows in one round trip.
   */
  async findNumbersByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = (await this.db
      .selectFrom('invoice')
      .select(['id', 'number'])
      .where('id', 'in', ids)
      .execute()) as Array<{ id: string; number: string }>;
    return new Map(rows.map((row) => [row.id, row.number]));
  }

  /** Set the paperless document id once the PDF has been pushed. */
  async setPaperlessDocId(invoiceId: string, paperlessDocId: string): Promise<void> {
    await this.db
      .updateTable('invoice')
      .set({ paperlessDocId, updatedAt: new Date() })
      .where('id', '=', invoiceId)
      .execute();
  }

  /**
   * Unmatched invoices with matching gross + currency, issued within
   * `[issuedAfter, issuedBefore)`. Drives the bank-matcher's auto-low
   * heuristic for incoming payments — the service still narrows on a
   * fuzzy client-name match.
   */
  async findUnmatchedAmountAndIssueWindow(input: {
    totalMinor: bigint;
    currency: string;
    issuedAfter: Date;
    issuedBefore: Date;
  }): Promise<InvoiceHeuristicCandidate[]> {
    return (await this.db
      .selectFrom('invoice')
      .innerJoin('client', 'client.id', 'invoice.clientId')
      .select([
        'invoice.id as invoiceId',
        'invoice.number',
        'invoice.totalMinor',
        'invoice.currency',
        'invoice.issuedAt',
        'client.name as clientName',
      ])
      .where('invoice.totalMinor', '=', input.totalMinor)
      .where('invoice.currency', '=', input.currency)
      .where('invoice.issuedAt', '>=', input.issuedAfter)
      .where('invoice.issuedAt', '<', input.issuedBefore)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('bank_transaction')
              .select('id')
              .whereRef('bank_transaction.matchedInvoiceId', '=', 'invoice.id'),
          ),
        ),
      )
      .execute()) as InvoiceHeuristicCandidate[];
  }

  /**
   * Match-candidate list for the bank-tx Link modal. Substring search on
   * number + client name; unmatched-only when query is empty.
   */
  async findMatchCandidates(input: { query?: string; limit: number }): Promise<InvoiceMatchCandidate[]> {
    const like = input.query ? `%${input.query.toLowerCase()}%` : null;
    let qb = this.db
      .selectFrom('invoice')
      .leftJoin('client', 'client.id', 'invoice.clientId')
      .select([
        'invoice.id',
        'invoice.number',
        'invoice.totalMinor',
        'invoice.currency',
        'invoice.issuedAt',
        'client.name as clientName',
      ])
      .orderBy('invoice.issuedAt', 'desc')
      .limit(input.limit);
    qb = like
      ? qb.where((eb) =>
          eb.or([
            eb(eb.fn<string>('lower', ['invoice.number']), 'like', like),
            eb(eb.fn<string>('lower', ['client.name']), 'like', like),
          ]),
        )
      : qb.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('bank_transaction')
                .select('id')
                .whereRef('bank_transaction.matchedInvoiceId', '=', 'invoice.id'),
            ),
          ),
        );
    return (await qb.execute()) as InvoiceMatchCandidate[];
  }

  /**
   * Invoices "paid in `[start, end)`" — joined with bank_transaction on
   * matchedInvoiceId, where the bank_tx booked in the period. Drives the
   * kasstelsel income side of the quarterly aggregate.
   */
  async findPaidInPeriod(start: Date, end: Date): Promise<InvoicePaidRow[]> {
    return (await this.db
      .selectFrom('bank_transaction')
      .innerJoin('invoice', 'invoice.id', 'bank_transaction.matchedInvoiceId')
      .innerJoin('client', 'client.id', 'invoice.clientId')
      .select([
        'invoice.number',
        'invoice.totalMinor',
        'invoice.eurTotalMinor',
        'invoice.btwMinor',
        'invoice.currency',
        'client.class as clientClass',
      ])
      .where('bank_transaction.txDate', '>=', start)
      .where('bank_transaction.txDate', '<', end)
      .execute()) as InvoicePaidRow[];
  }

  /**
   * Count + small number-sample of invoices issued before `end` that still
   * have no matched bank_transaction. Wise-flow invoices (paid via Wise) are
   * excluded — their match lives on wise_transfer, not invoice. Drives the
   * quarterly-aggregator's "invoice_unmatched" warning.
   */
  async findUnmatchedBefore(input: {
    end: Date;
    sampleLimit: number;
  }): Promise<{ count: number; sampleNumbers: string[] }> {
    const base = this.db
      .selectFrom('invoice')
      .leftJoin('bank_transaction', 'bank_transaction.matchedInvoiceId', 'invoice.id')
      .where('invoice.issuedAt', '<', input.end)
      .where('invoice.wiseTransferId', 'is', null)
      .where('bank_transaction.id', 'is', null);

    const [countRow, sample] = await Promise.all([
      base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
      base.select(['invoice.number']).limit(input.sampleLimit).execute(),
    ]);
    return { count: Number(countRow.total), sampleNumbers: sample.map((row) => row.number) };
  }

  /**
   * Invoices issued in `[start, end)`, joined with client + the first
   * invoice_line (ordinal=0) for the accountant export. invoice_line is
   * left-joined because legacy / synthetic rows may not have lines yet.
   */
  async findInPeriodWithClientAndFirstLine(start: Date, end: Date): Promise<InvoiceExportRow[]> {
    return (
      (await this.db
        .selectFrom('invoice')
        .innerJoin('client', 'client.id', 'invoice.clientId')
        // invoice_line ordinals are 0-indexed (set by invoice-composer.service);
        // the first line carries the canonical description for the accountant.
        .leftJoin('invoice_line', (join_) =>
          join_.onRef('invoice_line.invoiceId', '=', 'invoice.id').on('invoice_line.ordinal', '=', 0),
        )
        .select([
          'invoice.number',
          'invoice.issuedAt',
          'invoice.totalMinor',
          'invoice.eurTotalMinor',
          'invoice.btwMinor',
          'invoice.currency',
          'client.name as clientName',
          'client.class as clientClass',
          'client.vatId',
          'client.defaultDescription',
          'invoice_line.description as lineDescription',
        ])
        .where('invoice.issuedAt', '>=', start)
        .where('invoice.issuedAt', '<', end)
        .orderBy('invoice.issuedAt', 'asc')
        .execute()) as InvoiceExportRow[]
    );
  }
}

/** Row returned by `findPaidInPeriod` — slim projection for the quarterly aggregator. */
export type InvoicePaidRow = {
  number: string;
  totalMinor: bigint | string;
  eurTotalMinor: bigint | string | null;
  btwMinor: bigint | string | null;
  currency: string;
  clientClass: string;
};

export type InvoiceExportRow = {
  number: string;
  issuedAt: Date | string;
  totalMinor: bigint | string;
  eurTotalMinor: bigint | string | null;
  btwMinor: bigint | string | null;
  currency: string;
  clientName: string;
  clientClass: string;
  vatId: string | null;
  defaultDescription: string | null;
  lineDescription: string | null;
};

/**
 * Allocate the next `YYYY/NNN` invoice number for the given year, gap-free.
 * Upsert pattern lets the first invoice of a new year auto-create the row.
 * Wrapped in the issuing transaction to prevent races.
 */
/** Heuristic-candidate row used by the bank-matcher auto-low path. */
export type InvoiceHeuristicCandidate = {
  invoiceId: string;
  number: string;
  totalMinor: bigint | string;
  currency: string;
  issuedAt: Date | string;
  clientName: string;
};

/** Abbreviated row used by the manual match-candidate picker. */
export type InvoiceMatchCandidate = {
  id: string;
  number: string;
  totalMinor: bigint | string;
  currency: string;
  issuedAt: Date | string;
  clientName: string | null;
};

async function allocateInvoiceNumber(trx: Transaction<DB>, year: number): Promise<string> {
  const result = await sql<{ lastNumber: number }>`
    INSERT INTO "invoice_number_sequence" ("year", "lastNumber")
    VALUES (${year}, 1)
    ON CONFLICT ("year") DO UPDATE SET "lastNumber" = "invoice_number_sequence"."lastNumber" + 1
    RETURNING "lastNumber"
  `.execute(trx);
  const next = result.rows[0]?.lastNumber;
  if (next === undefined) {
    throw new Error(`Failed to allocate invoice number for year ${year}`);
  }
  return `${year}/${String(next).padStart(3, '0')}`;
}
