import { PaperlessApiError, PaperlessService } from 'src/services/paperless.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response;

const errorResponse = (status: number, body: unknown): Response =>
  ({
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as Response;

beforeEach(() => {
  process.env.OIDC_ISSUER ??= 'http://idp.test';
  process.env.OIDC_CLIENT_ID ??= 'test';
  process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  process.env.PAPERLESS_BASE_URL = 'https://paperless.fake';
  process.env.PAPERLESS_TOKEN = 'fake-token';
});

describe('PaperlessService', () => {
  it('uploads a document and returns the consume task id (string-quoted body)', async () => {
    // paperless's post_document returns the task UUID as a JSON string.
    const fetchFn = vi.fn().mockResolvedValue(okResponse('"abc-123-task"'));

    const service = new PaperlessService(fetchFn);
    const result = await service.uploadDocument({
      file: Buffer.from('%PDF-1.7 fake'),
      filename: '2099-001.pdf',
      title: 'OverseasClientCo 2099/001',
    });

    expect(result.taskId).toBe('abc-123-task');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://paperless.fake/api/documents/post_document/');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Token fake-token');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('uploads a document when paperless returns an object body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ task_id: 'def-456' }));
    const service = new PaperlessService(fetchFn);
    const result = await service.uploadDocument({
      file: Buffer.from('pdf'),
      filename: 'x.pdf',
      title: 'x',
    });
    expect(result.taskId).toBe('def-456');
  });

  it('throws PaperlessApiError on non-2xx upload', async () => {
    const fetchFn = vi.fn().mockResolvedValue(errorResponse(401, { detail: 'unauthenticated' }));
    const service = new PaperlessService(fetchFn);
    await expect(
      service.uploadDocument({ file: Buffer.from('pdf'), filename: 'x.pdf', title: 'x' }),
    ).rejects.toBeInstanceOf(PaperlessApiError);
  });

  it('waitForDocumentId polls until SUCCESS and returns related_document', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okResponse([{ status: 'PENDING' }]))
      .mockResolvedValueOnce(okResponse([{ status: 'STARTED' }]))
      .mockResolvedValueOnce(okResponse([{ status: 'SUCCESS', related_document: 4242 }]));

    const service = new PaperlessService(fetchFn);
    const docId = await service.waitForDocumentId('abc-123-task', { attempts: 5, intervalMs: 1 });
    expect(docId).toBe('4242');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('waitForDocumentId throws when the consume task fails', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(okResponse([{ status: 'FAILURE', result: 'corrupted PDF' }]));

    const service = new PaperlessService(fetchFn);
    await expect(service.waitForDocumentId('bad-task', { attempts: 5, intervalMs: 1 })).rejects.toThrow(
      /corrupted PDF/,
    );
  });

  it('throws if PAPERLESS_BASE_URL is missing', async () => {
    delete process.env.PAPERLESS_BASE_URL;
    const fetchFn = vi.fn();
    const service = new PaperlessService(fetchFn);
    await expect(service.uploadDocument({ file: Buffer.from('pdf'), filename: 'x.pdf', title: 'x' })).rejects.toThrow(
      /PAPERLESS_BASE_URL/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
