import { InvoiceComposeDto } from 'src/dtos/invoice.dto';
import { describe, expect, it } from 'vitest';

/**
 * Regression: clientId schema used to be `uuidv4()` while the DB generates
 * `uuidv7()` ids — every real clientId was rejected as "Invalid UUID" with
 * the actual problem buried in the validation message.
 */
describe('InvoiceComposeDto', () => {
  const goodLines = [{ description: 'Services', lineTotalMinor: '10000' }];

  it('accepts a uuidv7 clientId (matches what the DB generates)', () => {
    const result = InvoiceComposeDto.schema.safeParse({
      clientId: '019e0436-adae-78d6-a846-0e7af8314ec2',
      issuedAt: '2099-03-05',
      currency: 'EUR',
      lines: goodLines,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a uuidv4 clientId too', () => {
    const result = InvoiceComposeDto.schema.safeParse({
      clientId: 'a89efb15-cd23-4b40-9f0c-29afde3a35b1',
      issuedAt: '2099-03-05',
      currency: 'EUR',
      lines: goodLines,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID clientId with a clear path', () => {
    const result = InvoiceComposeDto.schema.safeParse({
      clientId: 'not-a-uuid',
      issuedAt: '2099-03-05',
      currency: 'EUR',
      lines: goodLines,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const clientIdIssue = result.error.issues.find((issue) => issue.path[0] === 'clientId');
      expect(clientIdIssue).toBeDefined();
    }
  });
});
