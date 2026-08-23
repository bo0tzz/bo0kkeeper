import { PaperlessApiError, PaperlessRepository } from 'src/repositories/paperless.repository';
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

describe('PaperlessRepository', () => {
  it('uploads a document and returns the consume task id (string-quoted body)', async () => {
    // paperless's post_document returns the task UUID as a JSON string.
    const fetchFn = vi.fn().mockResolvedValue(okResponse('"abc-123-task"'));

    const service = new PaperlessRepository(fetchFn);
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
    const service = new PaperlessRepository(fetchFn);
    const result = await service.uploadDocument({
      file: Buffer.from('pdf'),
      filename: 'x.pdf',
      title: 'x',
    });
    expect(result.taskId).toBe('def-456');
  });

  it('throws PaperlessApiError on non-2xx upload', async () => {
    const fetchFn = vi.fn().mockResolvedValue(errorResponse(401, { detail: 'unauthenticated' }));
    const service = new PaperlessRepository(fetchFn);
    await expect(
      service.uploadDocument({ file: Buffer.from('pdf'), filename: 'x.pdf', title: 'x' }),
    ).rejects.toBeInstanceOf(PaperlessApiError);
  });

  // Regression: paperless-ngx v3.0 flipped the tasks endpoint to API v10 by
  // default — paginated response wrapper, lowercase status enum,
  // `related_document_ids: number[]` in place of `related_document: number`.
  // The old v9-shaped parser here silently timed out on every poll, which pg-boss
  // amplified into duplicate uploads on retry. This spec locks in v10 shape.
  it('waitForDocumentId polls until success (v10) and returns related_document_ids[0]', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ count: 1, results: [{ status: 'pending' }] }))
      .mockResolvedValueOnce(okResponse({ count: 1, results: [{ status: 'started' }] }))
      .mockResolvedValueOnce(okResponse({ count: 1, results: [{ status: 'success', related_document_ids: [4242] }] }));

    const service = new PaperlessRepository(fetchFn);
    const docId = await service.waitForDocumentId('abc-123-task', { attempts: 5, intervalMs: 1 });
    expect(docId).toBe('4242');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('waitForDocumentId sends the v10 Accept header so paperless routes to the v10 serializer', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ count: 1, results: [{ status: 'success', related_document_ids: [7] }] }));

    const service = new PaperlessRepository(fetchFn);
    await service.waitForDocumentId('t', { attempts: 1, intervalMs: 1 });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/json; version=10');
    expect(headers['Authorization']).toBe('Token fake-token');
  });

  it('waitForDocumentId throws when the consume task fails (v10 shape)', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      okResponse({
        count: 1,
        results: [{ status: 'failure', result_data: { error_message: 'corrupted PDF' } }],
      }),
    );

    const service = new PaperlessRepository(fetchFn);
    await expect(service.waitForDocumentId('bad-task', { attempts: 5, intervalMs: 1 })).rejects.toThrow(
      /corrupted PDF/,
    );
  });

  it('throws if PAPERLESS_BASE_URL is missing', async () => {
    delete process.env.PAPERLESS_BASE_URL;
    const fetchFn = vi.fn();
    const service = new PaperlessRepository(fetchFn);
    await expect(service.uploadDocument({ file: Buffer.from('pdf'), filename: 'x.pdf', title: 'x' })).rejects.toThrow(
      /PAPERLESS_BASE_URL/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe('checkTagsExist', () => {
    it('returns per-name existence + id from the live tag set', async () => {
      const fetchFn = vi.fn().mockResolvedValueOnce(
        okResponse({
          results: [
            { id: 1, name: 'Business' },
            { id: 2, name: 'Bills' },
          ],
          next: null,
        }),
      );
      const service = new PaperlessRepository(fetchFn);
      const result = await service.checkTagsExist(['Business', 'Buisness', 'Bills']);
      expect(result).toEqual([
        { name: 'Business', exists: true, id: 1 },
        { name: 'Buisness', exists: false, id: null },
        { name: 'Bills', exists: true, id: 2 },
      ]);
    });

    it('is case-sensitive — paperless tags are', async () => {
      const fetchFn = vi.fn().mockResolvedValueOnce(okResponse({ results: [{ id: 1, name: 'Business' }], next: null }));
      const service = new PaperlessRepository(fetchFn);
      const result = await service.checkTagsExist(['business']);
      expect(result[0].exists).toBe(false);
    });

    it('does not call paperless for an empty input', async () => {
      const fetchFn = vi.fn();
      const service = new PaperlessRepository(fetchFn);
      const result = await service.checkTagsExist([]);
      expect(result).toEqual([]);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
});
