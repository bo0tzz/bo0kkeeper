/**
 * Transform the user's local raw data (`data/` at the repo root, gitignored) into
 * committable scrubbed fixtures under `test/fixtures/`.
 *
 * Determinism contract: the same real input always produces the same scrubbed
 * output, so fixtures stay stable across re-scrubs and cross-row references
 * (counterparty names, transfer IDs) keep matching.
 *
 * Skeleton only — Phase 0h. Real source-specific transforms land alongside the
 * Wise/bank/paperless ingestion handlers in Phase 1+.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const DATA_DIR = resolve(process.cwd(), '../data');
const FIXTURES_DIR = resolve(process.cwd(), 'test/fixtures');

type Source = 'wise' | 'bank' | 'paperless';

const sources: Source[] = ['wise', 'bank', 'paperless'];

async function scrubWise(): Promise<void> {
  // TODO: parse data/wise-transaction-history.csv and emit scrubbed JSON fixtures
  // matching the Wise webhook payload shape (balances#credit, transfers#state-change).
  console.log('  (wise scrub not implemented yet)');
}

async function scrubBank(): Promise<void> {
  // TODO: parse data/transactie-historie_*.csv (SNS) and emit scrubbed bank-transaction
  // fixtures using the canonical normalized shape (see docs/schema.md).
  console.log('  (bank scrub not implemented yet)');
}

async function scrubPaperless(): Promise<void> {
  // TODO: walk data/google-drive/invoices/ for sample expense docs (when we have any),
  // emit synthesized paperless.document.consumed fixtures.
  console.log('  (paperless scrub not implemented yet)');
}

async function main() {
  if (!existsSync(DATA_DIR)) {
    console.error(`No raw data directory found at ${DATA_DIR}. Place real exports there to scrub.`);
    process.exit(2);
  }

  await mkdir(FIXTURES_DIR, { recursive: true });
  const filterArg = process.argv[2] as Source | undefined;
  const targets = filterArg ? [filterArg] : sources;

  for (const source of targets) {
    if (!sources.includes(source)) {
      console.error(`Unknown source: ${source}. One of ${sources.join(', ')}.`);
      process.exit(2);
    }
    await mkdir(resolve(FIXTURES_DIR, source), { recursive: true });
    console.log(`Scrubbing ${source}…`);
    switch (source) {
      case 'wise': {
        await scrubWise();
        break;
      }
      case 'bank': {
        await scrubBank();
        break;
      }
      case 'paperless': {
        await scrubPaperless();
        break;
      }
    }
  }

  // Touch dir to confirm it's there.
  const entries = await readdir(FIXTURES_DIR);
  console.log(`Done. Fixtures dir contains: ${entries.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
