import { ClientClass } from 'src/enum';
import { quarterTabName, SheetWriterService } from 'src/services/sheet-writer.service';
import { SheetsService } from 'src/services/sheets.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
});

describe('SheetWriterService', () => {
  let sheets: SheetsService;
  let ensureTab: ReturnType<typeof vi.fn>;
  let appendRow: ReturnType<typeof vi.fn>;
  let writer: SheetWriterService;

  beforeEach(() => {
    sheets = new SheetsService(vi.fn());
    ensureTab = vi.fn().mockResolvedValue(0);
    appendRow = vi.fn().mockResolvedValue(null);
    sheets.ensureTab = ensureTab;
    sheets.appendRow = appendRow;
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

    expect(ensureTab).toHaveBeenCalledWith('2099 Q1');
    const [tab, row] = appendRow.mock.calls[0] as [string, (string | number | null)[]];
    expect(tab).toBe('2099 Q1');
    expect(row).toEqual([
      '15/01/2099',
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
      '05/03/2099',
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

  it('quarterTabName: month boundaries', () => {
    expect(quarterTabName(new Date('2099-01-01T00:00:00Z'))).toBe('2099 Q1');
    expect(quarterTabName(new Date('2099-03-31T23:59:59Z'))).toBe('2099 Q1');
    expect(quarterTabName(new Date('2099-04-01T00:00:00Z'))).toBe('2099 Q2');
    expect(quarterTabName(new Date('2099-12-31T23:59:59Z'))).toBe('2099 Q4');
    expect(quarterTabName(new Date('2100-01-01T00:00:00Z'))).toBe('2100 Q1');
  });
});
