import { resolve } from 'node:path';
import { RenderService } from 'src/services/render.service';
import { describe, expect, it } from 'vitest';

const TEMPLATES_DIR = resolve(process.cwd(), 'src/templates');

describe('RenderService — domestic template', () => {
  const service = new RenderService(TEMPLATES_DIR);

  it('renders a domestic invoice with subtotal/BTW/total + payment block', async () => {
    const pdf = await service.render({
      template: 'domestic',
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
          subtotal: '197.50',
          btwRate: '21%',
          btwAmount: '41.48',
          total: '238.98',
        },
        lines: [
          { description: 'Design, Rock 5B modular enclosure', unit: '€15/hr', quantity: '11 hours', total: '165,-' },
          { description: '3D printing', unit: '€25/kg', quantity: '1.3kg', total: '32,50' },
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
