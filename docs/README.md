# Documentation

Living design docs for bo0kkeeper. Update as decisions evolve; remove stale parts rather than letting them rot.

## Index

- [overview.md](overview.md) — system architecture, components, request and job flow
- [domain.md](domain.md) — bookkeeping concepts (kasstelsel, trade names, invoice numbering, BTW, sheet shape)
- [schema.md](schema.md) — events table + state tables
- [phasing.md](phasing.md) — rollout plan, Phase 0 through 9
- [decisions.md](decisions.md) — log of design decisions with rationale

## Conventions

- These docs are **public-safe**: don't put real names, KvK, BTW IDs, IBANs, real client identifiers, or actual bookkeeping figures here. The repo may go public.
- Decisions belong in `decisions.md` as bullet entries with **why**. Don't argue trade-offs in the main docs — link to a decision.
- "Real" sample data lives in the gitignored `data/` directory. Committed fixtures are scrubbed/synthesized.
