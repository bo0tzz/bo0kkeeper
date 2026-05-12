import { ClientClass, ExpenseLocationClass } from 'src/enum';
import { SheetsRepository } from 'src/repositories/sheets.repository';
import {
  QUARTER_TAB_COLUMN_FORMATS,
  QUARTER_TAB_HEADERS,
  quarterTabName,
  SheetWriterService,
} from 'src/services/sheet-writer.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
});

describe('SheetWriterService', () => {
  let sheets: SheetsRepository;
  let ensureTab: ReturnType<typeof vi.fn>;
  let appendRow: ReturnType<typeof vi.fn>;
  let autoResizeColumns: ReturnType<typeof vi.fn>;
  let writer: SheetWriterService;

  beforeEach(() => {
    sheets = new SheetsRepository(vi.fn());
    ensureTab = vi.fn().mockResolvedValue(777);
    appendRow = vi.fn().mockResolvedValue(null);
    autoResizeColumns = vi.fn().mockResolvedValue(null);
    sheets.ensureTab = ensureTab;
    sheets.appendRow = appendRow;
    sheets.autoResizeColumns = autoResizeColumns;
    writer = new SheetWriterService(sheets);
  });

  it('writes a Non-EU income row with the existing column layout', async () => {
    await writer.writeIncomeRow({
      date: new Date('2099-01-15T13:26:00Z'),
      invoiceNumber: '2099/001',
      eurAmountMinor: 404_572n,
      client: { name: 'FAKECO', class: ClientClass.NonEu },
      source: 'wise:transfer/9999999',
    });

    expect(ensureTab).toHaveBeenCalledWith('2099 Q1', {
      headers: QUARTER_TAB_HEADERS,
      columnFormats: QUARTER_TAB_COLUMN_FORMATS,
    });
    const [tab, row] = appendRow.mock.calls[0] as [string, (string | number | null)[]];
    expect(tab).toBe('2099 Q1');
    expect(row).toEqual([
      '2099-01-15',
      '2099/001',
      'Income',
      'Non-EU',
      'FAKECO',
      'Wise',
      4045.72,
      '',
      '',
      '',
      'wise:transfer/9999999',
    ]);
  });

  it('writes a Domestic row with VAT and SNS Account as the income target', async () => {
    await writer.writeIncomeRow({
      date: new Date('2099-03-05T00:00:00Z'),
      invoiceNumber: '2099/006',
      eurAmountMinor: 23_898n,
      client: { name: 'F. Acme Studio', class: ClientClass.Domestic },
      vatPercent: '21%',
      vatMinor: 4148n,
      notes: '3D design & print services',
    });

    const [, row] = appendRow.mock.calls[0] as [string, (string | number | null)[]];
    expect(row).toEqual([
      '2099-03-05',
      '2099/006',
      'Income',
      'Domestic',
      'F. Acme Studio',
      'SNS Account',
      238.98,
      '21%',
      41.48,
      '3D design & print services',
      '',
    ]);
  });

  it('writes a Domestic expense row with VAT and SNS Account as the payer', async () => {
    await writer.writeExpenseRow({
      date: new Date('2099-02-20T00:00:00Z'),
      paperlessDocId: '4242',
      vendor: 'Daily Groceries NL',
      eurAmountMinor: 1599n,
      locationClass: ExpenseLocationClass.Domestic,
      vatPercent: '9%',
      vatMinor: 132n,
      notes: 'office snacks',
      source: 'expense/some-uuid',
    });

    expect(ensureTab).toHaveBeenCalledWith('2099 Q1', {
      headers: QUARTER_TAB_HEADERS,
      columnFormats: QUARTER_TAB_COLUMN_FORMATS,
    });
    const [tab, row] = appendRow.mock.calls[0] as [string, (string | number | null)[]];
    expect(tab).toBe('2099 Q1');
    expect(row).toEqual([
      '2099-02-20',
      '4242',
      'Expense',
      'Domestic',
      'SNS Account',
      'Daily Groceries NL',
      15.99,
      '9%',
      1.32,
      'office snacks',
      'expense/some-uuid',
    ]);
  });

  it('writes a Non-EU expense row with blank VAT and a custom "From"', async () => {
    await writer.writeExpenseRow({
      date: new Date('2099-04-10T00:00:00Z'),
      paperlessDocId: '7777',
      vendor: 'AWS',
      eurAmountMinor: 12_345n,
      locationClass: ExpenseLocationClass.NonEu,
      from: 'Wise',
    });

    const [, row] = appendRow.mock.calls[0] as [string, (string | number | null)[]];
    expect(row).toEqual(['2099-04-10', '7777', 'Expense', 'Non-EU', 'Wise', 'AWS', 123.45, '', '', '', '']);
  });

  it('income write fits columns to data after appending', async () => {
    await writer.writeIncomeRow({
      date: new Date('2099-01-15T00:00:00Z'),
      invoiceNumber: '2099/001',
      eurAmountMinor: 100n,
      client: { name: 'X', class: ClientClass.Domestic },
    });
    expect(autoResizeColumns).toHaveBeenCalledOnce();
    expect(autoResizeColumns).toHaveBeenCalledWith('2099 Q1', 777, QUARTER_TAB_HEADERS.length);
  });

  it('expense write fits columns to data after appending', async () => {
    await writer.writeExpenseRow({
      date: new Date('2099-01-15T00:00:00Z'),
      paperlessDocId: 'x',
      vendor: 'Y',
      eurAmountMinor: 100n,
      locationClass: ExpenseLocationClass.Domestic,
    });
    expect(autoResizeColumns).toHaveBeenCalledOnce();
    expect(autoResizeColumns).toHaveBeenCalledWith('2099 Q1', 777, QUARTER_TAB_HEADERS.length);
  });

  it('quarterTabName: month boundaries', () => {
    expect(quarterTabName(new Date('2099-01-01T00:00:00Z'))).toBe('2099 Q1');
    expect(quarterTabName(new Date('2099-03-31T23:59:59Z'))).toBe('2099 Q1');
    expect(quarterTabName(new Date('2099-04-01T00:00:00Z'))).toBe('2099 Q2');
    expect(quarterTabName(new Date('2099-12-31T23:59:59Z'))).toBe('2099 Q4');
    expect(quarterTabName(new Date('2100-01-01T00:00:00Z'))).toBe('2100 Q1');
  });
});
