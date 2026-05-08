import { RenderService } from 'src/services/render.service';
import { describe, expect, it } from 'vitest';

describe('RenderService — domestic variant', () => {
  const service = new RenderService();

  it('renders a domestic invoice with subtotal/BTW/total + payment block', async () => {
    const pdf = await service.render({
      template: 'invoice',
      data: {
        issuer: {
          name: 'de Willigen IT Services',
          addressLine1: 'Example Street 1',
          postalCode: '1234 AB',
          city: 'Exampletown',
          country: 'The Netherlands',
          kvk: '00000000',
          vatId: 'NL000000000B00',
        },
        client: {
          name: 'Test Acme Studio',
          addressLine1: 'Example Street 99',
          city: '5678CD Otherville',
        },
        invoice: {
          number: '2099/006',
          dateFormatted: '5 March 2099',
        },
        table: {
          headers: ['Description', 'Unit', 'Amount', 'Total'],
          aligns: ['left', 'right', 'right', 'right'],
          rows: [
            ['Design, Rock 5B modular enclosure', '€15/hr', '11 hours', '€ 165,-'],
            ['3D printing', '€25/kg', '1.3kg', '€ 32,50'],
          ],
        },
        summary: [
          { label: 'Subtotal', value: '€ 197,50' },
          { label: 'BTW (21%)', value: '€ 41,48' },
          { label: 'Total', value: '€ 238,98', emphasised: true },
        ],
        payment: {
          iban: 'NL00 BANK 0000 0000 00',
          name: 'de Willigen IT Services',
        },
      },
    });

    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });
});
