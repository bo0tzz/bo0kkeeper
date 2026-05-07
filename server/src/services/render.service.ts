import { Injectable, Logger, Optional } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Path resolver for templates — defaults to `dist/templates/` (post-build). */
export const TEMPLATES_DIR = resolve(process.cwd(), 'dist/templates');

export type RenderInput = {
  template: 'overseas-non-eu' | 'overseas-non-eu-bonus' | 'domestic';
  data: Record<string, unknown>;
};

/**
 * Render a Typst template to PDF, returning the PDF as a Buffer.
 *
 * Approach: copy the .typ template + write the JSON data to a temp dir,
 * shell out to `typst compile`, slurp the PDF, clean up. `typst` must be on
 * PATH (mise.toml pins it for dev; production container image bundles it).
 *
 * Spawning is wrapped in `runTypst` so unit tests can substitute a fake.
 */
@Injectable()
export class RenderService {
  private readonly logger = new Logger(RenderService.name);

  constructor(
    @Optional() private readonly templatesDir: string = TEMPLATES_DIR,
    @Optional() private readonly typstBin: string = process.env.TYPST_BIN ?? 'typst',
  ) {}

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
