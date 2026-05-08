import { resolve } from 'node:path';
import { RenderService } from 'src/services/render.service';
import { afterAll, describe, expect, it } from 'vitest';

const TEMPLATES_DIR = resolve(process.cwd(), 'src/templates');

describe('RenderService — typst integration', () => {
  // Use src/templates/ directly so the test isn't sensitive to whether `nest build` ran.
  const service = new RenderService(TEMPLATES_DIR);

  it('renders a non-EU OverseasClientCo invoice as a non-empty PDF', async () => {
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
          name: 'FAKECO',
          addressLine1: '1 Fake Park Dr',
          city: 'Nowhere, Nullstate, USA',
        },
        invoice: {
          number: '2099/001',
          dateFormatted: 'January 15, 2099',
        },
        table: {
          headers: ['Description', 'Amount'],
          aligns: ['left', 'right'],
          rows: [['Provided services, January 1 - January 15', '$ 4791 (€ 4045.72)']],
        },
        summary: [{ label: 'Amount', value: '$ 4791 (€ 4045.72)', emphasised: true }],
        footer: 'NO VAT because non EU',
      },
    });

    expect(pdf.byteLength).toBeGreaterThan(1000);
    // PDF magic header is %PDF-
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  afterAll(() => {
    // no-op; just to silence vitest about no afterAll if we add tear-down later
  });
});
