import { parseBtwFromDescription } from 'src/utils/btw-description';
import { describe, expect, it } from 'vitest';

describe('parseBtwFromDescription', () => {
  it('parses the canonical SNS klantonderzoek format', () => {
    const desc =
      'Kosten Klantonderzoek de Willigen IT Services Mei 2026 21% BTW BTW bedrag: 0,32 BTW BTW-nummer Volksbank: NL813633683B01';
    expect(parseBtwFromDescription(desc)).toEqual({ rateBps: 2100, amountMinor: 32n });
  });

  it('handles whole-euro amounts', () => {
    expect(parseBtwFromDescription('Foo 21% BTW BTW bedrag: 5,00 BTW')).toEqual({ rateBps: 2100, amountMinor: 500n });
  });

  it('handles 9% (lower BTW tariff)', () => {
    expect(parseBtwFromDescription('Foo 9% BTW BTW bedrag: 1,80 BTW')).toEqual({ rateBps: 900, amountMinor: 180n });
  });

  it('is case-insensitive', () => {
    expect(parseBtwFromDescription('FOO 21% btw btw BEDRAG: 0,32')).toEqual({ rateBps: 2100, amountMinor: 32n });
  });

  it('returns null when neither rate nor amount is present', () => {
    expect(parseBtwFromDescription('Just a normal payment')).toBeNull();
  });

  it('returns null when only rate is present', () => {
    expect(parseBtwFromDescription('21% BTW but no amount stated')).toBeNull();
  });

  it('returns null when only amount is present (no rate is a red flag)', () => {
    expect(parseBtwFromDescription('Some text BTW bedrag: 0,32')).toBeNull();
  });

  it('returns null for null/empty', () => {
    expect(parseBtwFromDescription(null)).toBeNull();
    expect(parseBtwFromDescription('')).toBeNull();
  });

  it('returns null for impossible rates', () => {
    expect(parseBtwFromDescription('0% BTW BTW bedrag: 0,00')).toBeNull();
    expect(parseBtwFromDescription('150% BTW BTW bedrag: 0,32')).toBeNull();
  });
});
