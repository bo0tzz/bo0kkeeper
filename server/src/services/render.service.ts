import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Templates live under `src/templates/` and are read directly at runtime —
 * no dist-copy step. cwd is the server package root in dev, prod (container
 * WORKDIR) and tests, so this resolves consistently. Override with the
 * `templatesDir` constructor arg for fixtures.
 */
export const TEMPLATES_DIR = resolve(process.cwd(), 'src/templates');
const KNOWN_TEMPLATES = ['invoice'] as const;

export type RenderInput = {
  /** Bare name, no extension — looks up `<templatesDir>/<template>.typ`. */
  template: (typeof KNOWN_TEMPLATES)[number];
  data: Record<string, unknown>;
};

/**
 * Render a Typst template to PDF, returning the PDF as a Buffer.
 *
 * Approach: copy the .typ template + write the JSON data to a temp dir,
 * shell out to `typst compile`, slurp the PDF, clean up. `typst` must be on
 * PATH (mise.toml pins it for dev; production container image bundles it).
 *
 * `runTypst` is protected so unit tests can substitute a fake spawner.
 */
@Injectable()
export class RenderService implements OnModuleInit {
  private readonly logger = new Logger(RenderService.name);

  constructor(
    @Optional() private readonly templatesDir: string = TEMPLATES_DIR,
    @Optional() private readonly typstBin: string = process.env.TYPST_BIN ?? 'typst',
  ) {}

  /**
   * Boot-time sanity check: every known template must be readable. Catches
   * "I deleted/renamed a template and forgot to update something" loud and
   * early instead of letting the first compose request 500.
   */
  onModuleInit(): void {
    const missing = KNOWN_TEMPLATES.filter((name) => !existsSync(join(this.templatesDir, `${name}.typ`)));
    if (missing.length > 0) {
      throw new Error(
        `RenderService: templates missing from ${this.templatesDir}: ${missing.join(', ')}. ` +
          `Did you delete a template without updating KNOWN_TEMPLATES, or is TEMPLATES_DIR wrong for this env?`,
      );
    }
  }

  async render(input: RenderInput): Promise<Buffer> {
    const work = await mkdtemp(join(tmpdir(), 'bo0kkeeper-render-'));
    try {
      const templateSource = join(this.templatesDir, `${input.template}.typ`);
      const templateDest = join(work, 'template.typ');
      const dataDest = join(work, 'data.json');
      const outputDest = join(work, 'output.pdf');

      await copyFile(templateSource, templateDest);
      await writeFile(dataDest, JSON.stringify(input.data, null, 2), 'utf8');

      await this.runTypst(['compile', templateDest, outputDest]);

      return await readFile(outputDest);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Spawn `typst` with given args; resolves on exit code 0, rejects otherwise. */
  protected runTypst(args: string[]): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.logger.debug(`typst ${args.join(' ')}`);
      const proc = spawn(this.typstBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on('error', (error) => rejectPromise(error));
      proc.on('exit', (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          rejectPromise(new Error(`typst exited with code ${code}: ${stderr || '(no stderr)'}`));
        }
      });
    });
  }
}
