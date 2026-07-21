import { EventSource } from 'src/enum';
import { paperlessPayloadShape, readPaperlessEventPayload, resolvePaperlessDocId } from 'src/utils/paperless-payload';
import { describe, expect, it } from 'vitest';

describe('resolvePaperlessDocId', () => {
  it('returns undefined when no id-carrying field is present', () => {
    expect(resolvePaperlessDocId({})).toBeUndefined();
  });

  it('returns numeric-string form when document_id is a positive integer', () => {
    expect(resolvePaperlessDocId({ document_id: 4242 })).toBe('4242');
    expect(resolvePaperlessDocId({ document_id: '4242' })).toBe('4242');
  });

  it('accepts id and doc_pk aliases', () => {
    expect(resolvePaperlessDocId({ id: 7 })).toBe('7');
    expect(resolvePaperlessDocId({ doc_pk: '99' })).toBe('99');
  });

  // paperless v2.20.x has no id-shaped placeholder, so workflows there send
  // `{{doc_url}}` and we peel the id off the URL tail.
  it('extracts the id from document_url', () => {
    expect(resolvePaperlessDocId({ document_url: 'https://paperless.test/documents/123/' })).toBe('123');
    expect(resolvePaperlessDocId({ document_url: 'http://paperless.local/documents/456' })).toBe('456');
  });

  // The exact class of bug behind the stuck expense in prod: users sometimes
  // point the `document_id` key at `{{doc_url}}` by accident, so the URL
  // lands in an id field. Storing that verbatim poisons paperlessDocId.
  it('unwraps a URL that landed in the document_id field', () => {
    expect(resolvePaperlessDocId({ document_id: 'https://paperless.test/documents/789/' })).toBe('789');
  });

  it('prefers earlier id-shaped fields over document_url', () => {
    expect(resolvePaperlessDocId({ document_id: 1, document_url: 'https://paperless.test/documents/2/' })).toBe('1');
  });

  it('rejects non-numeric, non-URL strings', () => {
    expect(resolvePaperlessDocId({ document_id: 'not-a-number' })).toBeUndefined();
    expect(resolvePaperlessDocId({ document_url: 'not-a-url' })).toBeUndefined();
  });

  it('rejects zero and negative ids', () => {
    expect(resolvePaperlessDocId({ document_id: 0 })).toBeUndefined();
    expect(resolvePaperlessDocId({ document_id: -1 })).toBeUndefined();
    expect(resolvePaperlessDocId({ document_url: 'https://paperless.test/documents/0/' })).toBeUndefined();
  });

  it('rejects URLs whose path does not include a documents segment', () => {
    expect(resolvePaperlessDocId({ document_url: 'https://paperless.test/other/123/' })).toBeUndefined();
  });
});

describe('paperlessPayloadShape', () => {
  it('parses a real webhook payload with document_url, correspondent, created', () => {
    const parsed = paperlessPayloadShape.parse({
      document_url: 'https://paperless.test/documents/679/',
      correspondent: 'Acme',
      created: '2026-07-15',
    });
    expect(parsed.document_url).toBe('https://paperless.test/documents/679/');
    expect(parsed.correspondent).toBe('Acme');
  });

  it('preserves unknown fields via passthrough', () => {
    const parsed = paperlessPayloadShape.parse({ document_id: 42, custom_field: 'anything' }) as Record<
      string,
      unknown
    >;
    expect(parsed.custom_field).toBe('anything');
  });
});

describe('readPaperlessEventPayload', () => {
  it('parses a paperless event payload back into the typed shape', () => {
    const payload = readPaperlessEventPayload({
      source: EventSource.Paperless,
      payload: { document_id: 42, created: '2026-07-15' },
    });
    expect(payload.document_id).toBe(42);
    expect(payload.created).toBe('2026-07-15');
  });

  it('throws when called with a non-paperless event source', () => {
    expect(() => readPaperlessEventPayload({ source: EventSource.Wise, payload: { document_id: 1 } })).toThrow(
      /source=/,
    );
  });

  it('throws when payload has drifted from the shape (wildly wrong types)', () => {
    expect(() =>
      readPaperlessEventPayload({ source: EventSource.Paperless, payload: { document_id: { nope: true } } }),
    ).toThrow();
  });
});
