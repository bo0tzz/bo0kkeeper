# Test fixtures

Scrubbed/synthesized payloads that exercise the same code paths as real production data, without leaking any real bookkeeping facts. **Everything in this directory is committed to the repo and may go public** — never put raw user data here.

## Layout

```
fixtures/
  wise/                  Wise webhook payloads (balances#credit, transfers#state-change)
  bank/                  Synthesized bank-transaction events (SNS-shaped today, Enable-Banking-shaped later)
  paperless/             Paperless-ngx document-consumed webhooks
  manual/                Manual events (e.g. invoice issuance from the admin UI)
```

Each fixture is a single JSON file matching the corresponding `events.payload` jsonb shape.

## Producing fixtures from real data

The `bin/scrub` tool reads from the gitignored `data/` directory at the repo root (the user's actual Wise/SNS/paperless exports) and emits scrubbed equivalents into this directory. It runs a deterministic transform:

- Counterparty names → consistent fake names (same real → same fake across rows)
- IBANs → fake but checksum-valid
- Amounts → rounded to nearest €/¢ unit (so structurally similar, numerically different)
- Dates → shifted by a fixed random offset
- Reference codes → format-preserved randomization (`TXN-NNNN` stays `TXN-NNNN` shape)

Determinism matters: if a real-data row is rescrubbed, the same fixture comes out. That keeps test inputs stable across re-scrubs.

## Replaying fixtures

`bin/replay <fixture-path>` POSTs a fixture to the local webhook endpoint with a valid signature. Exercises the whole verify+ingest path, not just the handler. Used both interactively during development and in integration tests.

## What's safe to commit

Yes:
- Synthesized JSON shapes that match real Wise/paperless/bank schemas.
- Edge cases (the FOSDEM-`borg`-style mixed-component expense, the multi-paycheck Wise inbound, etc.) — but with synthesized values.

No:
- Real names, IBANs, KvK, BTW IDs, invoice numbers.
- Real amounts. Always perturb or round.
- Real dates that line up with real life events.
