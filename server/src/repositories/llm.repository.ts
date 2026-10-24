import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { LlamaCompletion, LlamaContext, LlamaGrammar, LlamaModel } from 'node-llama-cpp';
import { mkdir } from 'node:fs/promises';
import { Config, loadConfig } from 'src/config';

type NodeLlamaCpp = typeof import('node-llama-cpp');

type LoadedModel = {
  lib: NodeLlamaCpp;
  model: LlamaModel;
  context: LlamaContext;
  completion: LlamaCompletion;
  grammar: LlamaGrammar;
};

export type ExtractInput = {
  /** NuExtract template: field name → type name (`'string'`, `['string']`, …). */
  template: Record<string, unknown>;
  /** One `- field: description` line per field. */
  descriptions: string;
  text: string;
};

/**
 * Receipt prompts measured 400–1900 tokens at the 8000-char text cap;
 * NuExtract output is a small JSON object.
 */
const CONTEXT_SIZE = 4096;
const MAX_OUTPUT_TOKENS = 512;

/**
 * In-process llama.cpp (CPU, prebuilt binary) running a NuExtract model for
 * structured extraction.
 *
 * The model is loaded on first use, downloaded into `EXTRACT_MODEL_DIR` when
 * the URI is remote, and unloaded again after `EXTRACT_MODEL_TTL` idle
 * seconds so its memory (~1.7GB plus the mmapped weights) is only held while
 * documents are being processed. Calls are serialized: there is one context
 * sequence.
 */
@Injectable()
export class LlmRepository implements OnModuleDestroy {
  private readonly logger = new Logger(LlmRepository.name);
  private readonly config: Config['extraction'];
  private loaded: Promise<LoadedModel> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor() {
    this.config = loadConfig().extraction;
  }

  isEnabled(): boolean {
    return !!this.config.modelUri;
  }

  /** Run a NuExtract template over `text`. Returns the parsed JSON, or null if the output wasn't JSON. */
  extract(input: ExtractInput): Promise<unknown> {
    return this.serialize(() => this.runExtract(input));
  }

  async onModuleDestroy(): Promise<void> {
    await this.serialize(() => this.unload());
  }

  private async runExtract(input: ExtractInput): Promise<unknown> {
    this.clearIdleTimer();
    try {
      const { lib, model, completion, grammar } = await this.load();
      const prompt = lib.LlamaText([
        new lib.SpecialTokensText('<|im_start|>user\n'),
        buildNuExtractPrompt(input),
        new lib.SpecialTokensText('<|im_end|>\n<|im_start|>assistant\n'),
      ]);
      const output = await completion.generateCompletion(prompt.tokenize(model.tokenizer), {
        grammar,
        temperature: 0,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
      try {
        return JSON.parse(output) as unknown;
      } catch {
        this.logger.warn(`Model output was not valid JSON (${output.length} chars)`);
        return null;
      }
    } finally {
      this.armIdleTimer();
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => {});
    return run;
  }

  private load(): Promise<LoadedModel> {
    if (!this.loaded) {
      this.loaded = this.doLoad();
      this.loaded.catch(() => {
        this.loaded = null;
      });
    }
    return this.loaded;
  }

  private async doLoad(): Promise<LoadedModel> {
    const uri = this.config.modelUri;
    if (!uri) {
      throw new Error('EXTRACT_MODEL_URI is not configured');
    }
    const lib = await import('node-llama-cpp');
    const llama = await lib.getLlama({
      gpu: false,
      build: 'never',
      progressLogs: false,
      logLevel: lib.LlamaLogLevel.warn,
      logger: (level, message) => this.logger.warn(`llama.cpp ${level}: ${message.trim()}`),
    });

    await mkdir(this.config.modelDir, { recursive: true });
    const started = Date.now();
    const modelPath = await lib.resolveModelFile(uri, { directory: this.config.modelDir, cli: false });
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext({ contextSize: CONTEXT_SIZE });
    const completion = new lib.LlamaCompletion({ contextSequence: context.getSequence() });
    const grammar = await llama.getGrammarFor('json');
    this.logger.log(`Loaded extraction model ${modelPath} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { lib, model, context, completion, grammar };
  }

  private async unload(): Promise<void> {
    this.clearIdleTimer();
    const loaded = await this.loaded?.catch(() => null);
    this.loaded = null;
    if (!loaded) {
      return;
    }
    await loaded.context.dispose();
    await loaded.model.dispose();
    this.logger.log('Unloaded extraction model');
  }

  private armIdleTimer(): void {
    if (this.config.modelTtlSeconds === 0) {
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.serialize(() => this.unload()).catch((error: unknown) => {
        this.logger.error(`Unloading extraction model failed: ${(error as Error).message}`);
      });
    }, this.config.modelTtlSeconds * 1000);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** NuExtract 2.0's text-only prompt layout. */
function buildNuExtractPrompt({ template, descriptions, text }: ExtractInput): string {
  return `### Template:\n${JSON.stringify(template, null, 2)}\n\n### Field descriptions:\n${descriptions}\n\n### Text:\n${text}\n`;
}
