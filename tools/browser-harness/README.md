# Browser harness

Interactive Playwright tooling for poking at the running dev stack. Used to:

- Walk every nav route + screenshot — `walk.mjs`
- Drive specific click flows + screenshot — `flows.mjs`
- Take a clipped screenshot of one route — `clip.mjs`
- Inspect a CSS-selector match's outerHTML — `inspect.mjs`
- Re-bootstrap auth state via SSO — `refresh-state.mjs`

Auth state lives at `state.json` (gitignored). It's reused across runs — the
silent-refresh path keeps it alive past the 5-minute access-token lifetime.
If state expires (or you clear it), `refresh-state.mjs` walks
`/api/auth/login` → Authentik SSO → callback to re-mint cookies.

## First-time setup

```bash
# Install deps + chromium binary (already done by pnpm install if playwright is in package.json).
pnpm install
pnpm exec playwright install chromium

# Bootstrap auth state. Either drives an interactive login (codegen)…
pnpm exec playwright codegen --save-storage=tools/browser-harness/state.json http://localhost:3000

# …or reuses your already-authenticated Authentik session via SSO.
node tools/browser-harness/refresh-state.mjs
```

## Daily use

```bash
# Sweep every route and screenshot.
node tools/browser-harness/walk.mjs

# Or a subset.
node tools/browser-harness/walk.mjs /banking /system /settings

# Run all click flows.
node tools/browser-harness/flows.mjs

# Just one flow.
node tools/browser-harness/flows.mjs settings-tag-check

# A clipped view of one route — useful when full-page screenshots come back
# too compressed in a multimodal model's render pipeline.
node tools/browser-harness/clip.mjs /banking 0 1000

# Poke at the rendered DOM of a selector — useful when the @immich/ui
# component you're trying to drive doesn't render the obvious primitive.
node tools/browser-harness/inspect.mjs /aggregator '[data-select-trigger]'
```

Screenshots land in `tools/browser-harness/screenshots/` (gitignored).

## Relationship to `web/e2e/`

The harness is the exploratory surface. Once a flow works reliably it moves
to `web/e2e/specs/*.spec.ts` as a proper Playwright assertion-based test —
those are the regression net (`pnpm --filter web test:browser`). The
harness sticks around for one-off poking and writing new flows.
