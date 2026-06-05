import { WiseApiError, WiseApiRepository } from 'src/repositories/wise-api.repository';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.OIDC_ISSUER = 'http://idp.test';
  process.env.OIDC_CLIENT_ID = 'test';
  process.env.OIDC_REDIRECT_URI = 'http://localhost/callback';
  process.env.WISE_API_BASE_URL = 'https://api.fake.wise';
  process.env.WISE_API_TOKEN = 'fake-token';
  process.env.WISE_PROFILE_ID = '12345';
  process.env.WISE_TARGET_RECIPIENT_ID = '67890';
});

const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as Response;

const errorResponse = (status: number, body: unknown): Response =>
  ({
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as Response;

describe('WiseApiRepository', () => {
  it('createQuote posts the right body shape and maps the response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        id: 'quote-uuid-1',
        rate: 0.846_991,
        sourceAmount: 4791,
        sourceCurrency: 'USD',
        targetCurrency: 'EUR',
        // v3 quotes return per-payIn-method options; the mapper picks one,
        // preferring BALANCE → DIRECT_DEBIT → BANK_TRANSFER.
        paymentOptions: [
          {
            payIn: 'BANK_TRANSFER',
            payOut: 'BANK_TRANSFER',
            disabled: true,
            sourceAmount: 4791,
            targetAmount: 4040,
            sourceCurrency: 'USD',
            targetCurrency: 'EUR',
            fee: { total: 18 },
          },
          {
            payIn: 'BALANCE',
            payOut: 'BANK_TRANSFER',
            disabled: false,
            sourceAmount: 4791,
            targetAmount: 4045.72,
            sourceCurrency: 'USD',
            targetCurrency: 'EUR',
            fee: { total: 14.42 },
          },
        ],
      }),
    );

    const service = new WiseApiRepository(fetchFn);
    const quote = await service.createQuote({
      sourceCurrency: 'USD',
      targetCurrency: 'EUR',
      sourceAmountMinor: 479_100n,
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.fake.wise/v3/profiles/12345/quotes');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer fake-token');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      sourceCurrency: 'USD',
      targetCurrency: 'EUR',
      sourceAmount: 4791,
      payOut: 'BANK_TRANSFER',
      preferredPayIn: 'BALANCE',
    });

    expect(quote.id).toBe('quote-uuid-1');
    expect(quote.rate).toBe('0.846991');
    expect(quote.feeMinor).toBe(1442n);
    expect(quote.sourceAmountMinor).toBe(479_100n);
    expect(quote.targetAmountMinor).toBe(404_572n);
  });

  it('createTransfer posts a body with the recipient id and our reference', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        id: 9_999_999,
        status: 'incoming_payment_waiting',
        reference: 'TXN-0044',
        rate: 0.846_991,
        sourceCurrency: 'USD',
        sourceValue: 4791,
        targetCurrency: 'EUR',
        targetValue: 4045.72,
        created: '2026-06-03T15:47:16Z',
      }),
    );

    const service = new WiseApiRepository(fetchFn);
    const transfer = await service.createTransfer({
      quoteId: 'quote-uuid-1',
      recipientId: 67_890,
      reference: 'TXN-0044',
    });

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.fake.wise/v1/transfers');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      targetAccount: 67_890,
      quoteUuid: 'quote-uuid-1',
      details: { reference: 'TXN-0044' },
    });
    expect(typeof body.customerTransactionId).toBe('string');
    expect(body.customerTransactionId).toMatch(/^[\da-f-]{36}$/i);

    expect(transfer.id).toBe(9_999_999);
    expect(transfer.state).toBe('incoming_payment_waiting');
    expect(transfer.reference).toBe('TXN-0044');
    expect(transfer.created).toBe('2026-06-03T15:47:16Z');
  });

  it('getTransfer GETs by id and maps the response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        id: 9_999_999,
        status: 'outgoing_payment_sent',
        reference: 'TXN-0044',
        rate: 0.846_991,
        sourceCurrency: 'USD',
        sourceValue: 4791,
        targetCurrency: 'EUR',
        targetValue: 4045.72,
      }),
    );

    const service = new WiseApiRepository(fetchFn);
    const transfer = await service.getTransfer(9_999_999);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.fake.wise/v1/transfers/9999999');
    expect(init.method).toBe('GET');
    expect(transfer.state).toBe('outgoing_payment_sent');
  });

  it('throws WiseApiError on non-2xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue(errorResponse(401, { errors: [{ code: 'unauthorized' }] }));

    const service = new WiseApiRepository(fetchFn);

    await expect(
      service.createQuote({ sourceCurrency: 'USD', targetCurrency: 'EUR', sourceAmountMinor: 1n }),
    ).rejects.toBeInstanceOf(WiseApiError);
  });

  it('throws if WISE_API_TOKEN is missing', async () => {
    delete process.env.WISE_API_TOKEN;
    const fetchFn = vi.fn();

    const service = new WiseApiRepository(fetchFn);

    await expect(
      service.createQuote({ sourceCurrency: 'USD', targetCurrency: 'EUR', sourceAmountMinor: 1n }),
    ).rejects.toThrow(/WISE_API_TOKEN/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
