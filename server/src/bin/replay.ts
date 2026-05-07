/**
 * Replay a fixture against a running server's webhook endpoint.
 *
 * Usage:
 *   pnpm replay <fixture-path>
 *   pnpm replay test/fixtures/wise/balance-credit.example.json
 *   pnpm replay --target http://localhost:2283/api/webhooks/wise <fixture>
 *
 * Signing: when REPLAY_SIGNING_KEY is set (path to an RSA PEM), the body is signed
 * with RSA-SHA256 and the signature is sent as the X-Signature-SHA256 header — same
 * shape Wise uses in production. Without the env var, the body is sent unsigned and
 * the server is expected to be in dev mode (signature verification gated).
 *
 * Endpoint conventions (Phase 0h placeholder; refined in Phase 1):
 *   wise → /api/webhooks/wise
 *   paperless → /api/webhooks/paperless
 *   bank → /api/ingest/bank   (no webhook source; manual replay only)
 */
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type CliOptions = {
  fixturePath: string;
  target: string;
  source: 'wise' | 'paperless' | 'bank' | 'manual';
};

const DEFAULT_BASE = process.env.REPLAY_BASE ?? 'http://localhost:2283';

function inferSource(fixturePath: string): CliOptions['source'] {
  const normalized = fixturePath.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('/wise/')) {
    return 'wise';
  }
  if (normalized.includes('/paperless/')) {
    return 'paperless';
  }
  if (normalized.includes('/bank/')) {
    return 'bank';
  }
  return 'manual';
}

function endpointFor(source: CliOptions['source']): string {
  switch (source) {
    case 'wise': {
      return `${DEFAULT_BASE}/api/webhooks/wise`;
    }
    case 'paperless': {
      return `${DEFAULT_BASE}/api/webhooks/paperless`;
    }
    case 'bank': {
      return `${DEFAULT_BASE}/api/ingest/bank`;
    }
    case 'manual': {
      return `${DEFAULT_BASE}/api/ingest/manual`;
    }
  }
}

function parseArgs(argv: string[]): CliOptions {
  let target: string | undefined;
  let fixturePath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target' || arg === '-t') {
      target = argv[++i];
    } else if (!arg.startsWith('--')) {
      fixturePath = arg;
    }
  }

  if (!fixturePath) {
    console.error('Usage: replay <fixture-path> [--target <url>]');
    throw new Error('fixture-path is required');
  }

  const source = inferSource(fixturePath);
  return {
    fixturePath: resolve(process.cwd(), fixturePath),
    target: target ?? endpointFor(source),
    source,
  };
}

async function maybeSign(body: string): Promise<Record<string, string>> {
  const keyPath = process.env.REPLAY_SIGNING_KEY;
  if (!keyPath) {
    return {};
  }
  const pem = await readFile(keyPath, 'utf8');
  const signer = createSign('RSA-SHA256');
  signer.update(body);
  signer.end();
  const signature = signer.sign(pem, 'base64');
  return { 'X-Signature-SHA256': signature };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const body = await readFile(opts.fixturePath, 'utf8');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Replay-Source': opts.source,
    ...(await maybeSign(body)),
  };

  const res = await fetch(opts.target, { method: 'POST', headers, body });
  const text = await res.text();
  console.log(`POST ${opts.target} → ${res.status}`);
  if (text) {
    console.log(text);
  }
  if (!res.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
