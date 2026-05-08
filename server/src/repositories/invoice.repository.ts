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
  async findPaginated(input: {
    year?: number;
    status?: 'open' | 'paid';
    offset: number;
    limit: number;
  }): Promise<{
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

    const totalRow = (await query
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirst()) as { count: string } | undefined;
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

  /** Set the paperless document id once the PDF has been pushed. */
  async setPaperlessDocId(invoiceId: string, paperlessDocId: string): Promise<void> {
    await this.db
      .updateTable('invoice')
      .set({ paperlessDocId, updatedAt: new Date() })
      .where('id', '=', invoiceId)
      .execute();
  }
}

/**
 * Allocate the next `YYYY/NNN` invoice number for the given year, gap-free.
 * Upsert pattern lets the first invoice of a new year auto-create the row.
 * Wrapped in the issuing transaction to prevent races.
 */
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
