import { Injectable, Logger, Optional } from '@nestjs/common';
import { Config, loadConfig } from 'src/config';

/**
 * Thin wrapper over paperless-ngx's REST API. Pushes generated invoice PDFs
 * (and, eventually, paperless-originated expense webhooks come back via the
 * inbound side; that's a separate concern in WebhookService).
 *
 * API used:
 * - `POST /api/documents/post_document/` — multipart upload with the file +
 *   optional metadata (title, correspondent_id, document_type_id, tags).
 *   Returns the consume task id (UUID) when status=200.
 * - `GET /api/tasks/?task_id=<uuid>` — poll for the assigned doc id.
 */

export type PaperlessUploadInput = {
  file: Buffer;
  filename: string;
  title: string;
  /** Optional ISO-8601 datestamp ("YYYY-MM-DD") to set as the document date. */
  created?: string;
  /** Numeric correspondent id (paperless taxonomy). */
  correspondentId?: number;
  /** Numeric document type id. */
  documentTypeId?: number;
  /** Numeric tag ids. */
  tagIds?: number[];
};

export type PaperlessUploadResult = {
  /** Consume task UUID — paperless ingests asynchronously. Poll for the doc id. */
  taskId: string;
};

export class PaperlessApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

@Injectable()
export class PaperlessService {
  private readonly logger = new Logger(PaperlessService.name);
  private readonly config: Config['paperless'];
  private readonly fetchFn: FetchLike;

  constructor(@Optional() fetchFn: FetchLike = fetch) {
    this.config = loadConfig().paperless;
    this.fetchFn = fetchFn;
  }

  async uploadDocument(input: PaperlessUploadInput): Promise<PaperlessUploadResult> {
    const baseUrl = this.requireBaseUrl();
    const token = this.requireToken();

    const form = new FormData();
    const blob = new Blob([input.file as unknown as BlobPart], { type: 'application/pdf' });
    form.set('document', blob, input.filename);
    form.set('title', input.title);
    if (input.created) {
      form.set('created', input.created);
    }
    if (input.correspondentId !== undefined) {
      form.set('correspondent', String(input.correspondentId));
    }
    if (input.documentTypeId !== undefined) {
      form.set('document_type', String(input.documentTypeId));
    }
    for (const tag of input.tagIds ?? []) {
      form.append('tags', String(tag));
    }

    const url = `${baseUrl}/api/documents/post_document/`;
    this.logger.debug(`paperless → POST ${url} (${input.filename})`);

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Token ${token}` },
      body: form,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new PaperlessApiError(response.status, safeJson(text), `Paperless upload failed: ${response.status}`);
    }

    const payload = safeJson(text);
    const taskId =
      typeof payload === 'string' ? payload.replaceAll('"', '') : (payload as { task_id?: string }).task_id;
    if (typeof taskId !== 'string' || !taskId) {
      throw new PaperlessApiError(response.status, payload, `Paperless upload returned no task id`);
    }
    return { taskId };
  }

  /**
   * Wait until paperless reports the given consume task as complete and return
   * the assigned document id. Bounded by attempts × intervalMs; throws on
   * timeout. paperless task statuses: PENDING, STARTED, SUCCESS, FAILURE.
   */
  async waitForDocumentId(taskId: string, opts: { attempts?: number; intervalMs?: number } = {}): Promise<string> {
    const baseUrl = this.requireBaseUrl();
    const token = this.requireToken();
    const attempts = opts.attempts ?? 30;
    const intervalMs = opts.intervalMs ?? 1000;

    for (let i = 0; i < attempts; i++) {
      const response = await this.fetchFn(`${baseUrl}/api/tasks/?task_id=${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: { Authorization: `Token ${token}` },
      });
      const text = await response.text();
      if (!response.ok) {
        throw new PaperlessApiError(
          response.status,
          safeJson(text),
          `Paperless task lookup failed: ${response.status}`,
        );
      }
      const tasks = safeJson(text) as Array<{ status: string; result?: string; related_document?: number | null }>;
      const task = tasks?.[0];
      if (task?.status === 'SUCCESS' && task.related_document != null) {
        return String(task.related_document);
      }
      if (task?.status === 'FAILURE') {
        throw new PaperlessApiError(0, task, `Paperless consume task failed: ${task.result ?? '(no detail)'}`);
      }
      await sleep(intervalMs);
    }
    throw new PaperlessApiError(0, null, `Paperless consume task ${taskId} did not complete in time`);
  }

  private requireBaseUrl(): string {
    if (!this.config.baseUrl) {
      throw new Error('PAPERLESS_BASE_URL is not configured');
    }
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private requireToken(): string {
    if (!this.config.token) {
      throw new Error('PAPERLESS_TOKEN is not configured');
    }
    return this.config.token;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
