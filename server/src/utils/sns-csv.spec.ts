import { BankSource } from 'src/enum';
import { parseSnsCsv } from 'src/utils/sns-csv';
import { describe, expect, it } from 'vitest';

const HEADER =
  'Datum,Je rekening,Van / naar,Naam,Adres,Postcode,Woonplaats,Valuta saldo,Saldo voor boeking,Valuta,Bedrag bij / af,Verwerkingsdatum,Valutadatum,Code,Type,Volgnummer,Betalingskenmerk,Omschrijving,Afschriftnummer';

describe('parseSnsCsv', () => {
  it('parses a basic row with the existing SNS column layout', () => {
    const csv = [
      HEADER,
      `01-08-2099,NL00BANK0000000000,BE03967415006984,Test Account Holder,,,,EUR,0.00,EUR,13493.97,01-08-2099,01-08-2099,8949,IOS,5710841,,'996460097-BE03967415006984-Test Account Holder-TXN-0002',32`,
    ].join('\n');

    const rows = parseSnsCsv(csv, 'NL00BANK0000000000');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.source).toBe(BankSource.SnsCsv);
    expect(row.externalId).toBe('32:5710841');
    expect(row.amountMinor).toBe(1_349_397n);
    expect(row.currency).toBe('EUR');
    expect(row.counterpartyName).toBe('Test Account Holder');
    expect(row.counterpartyIban).toBe('BE03967415006984');
    expect(row.description).toContain('TXN-0002');
    expect((row.txDate as Date).toISOString()).toBe('2099-08-01T00:00:00.000Z');
  });

  it('handles negative amounts (debits)', () => {
    const csv = [
      HEADER,
      `02-08-2099,NL00BANK0000000000,NL35RABO0117713678,Online Cable Shop BV,,,,EUR,13413.87,EUR,-90.95,02-08-2099,02-08-2099,9806,IDE,1792387,,'2551468554X6fa2e ORD125568',32`,
    ].join('\n');

    const rows = parseSnsCsv(csv, 'NL00BANK0000000000');
    expect(rows[0].amountMinor).toBe(-9095n);
    expect(rows[0].counterpartyName).toBe('Online Cable Shop BV');
  });

  it('preserves the full raw row in rawPayload', () => {
    const csv = [
      HEADER,
      `11-09-2099,NL00BANK0000000000,NL87ASNB8843857517,Test Counterparty,,,,EUR,14959.32,EUR,15.00,11-09-2099,11-09-2099,6853,BVZ,741611,,'3D print services (2099/005)',38`,
    ].join('\n');

    const rows = parseSnsCsv(csv, 'NL00BANK0000000000');
    const raw = rows[0].rawPayload as Record<string, string>;
    expect(raw.Datum).toBe('11-09-2099');
    expect(raw.Naam).toBe('Test Counterparty');
    expect(raw.Volgnummer).toBe('741611');
  });

  it('keys idempotency on Afschriftnummer:Volgnummer', () => {
    const csv = [
      HEADER,
      `01-08-2099,NL00BANK0000000000,X,Counter,,,,EUR,0,EUR,1.00,01-08-2099,01-08-2099,1,IDE,111,,'a',5`,
      `01-08-2099,NL00BANK0000000000,X,Counter,,,,EUR,0,EUR,1.00,01-08-2099,01-08-2099,1,IDE,222,,'b',5`,
    ].join('\n');

    const rows = parseSnsCsv(csv, 'NL00BANK0000000000');
    expect(rows.map((r) => r.externalId)).toEqual(['5:111', '5:222']);
  });

  it('throws on missing required columns', () => {
    const csv = 'foo,bar\n1,2';
    expect(() => parseSnsCsv(csv, 'NL00BANK0000000000')).toThrow(/SNS CSV missing column/);
  });
});
