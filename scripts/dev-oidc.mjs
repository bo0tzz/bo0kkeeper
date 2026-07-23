#!/usr/bin/env node
// Boots the in-process fake OIDC IDP on a fixed port so the local dev server
// has something to point OIDC_ISSUER at when the real Authentik client isn't
// available (rotated / offline / sandboxed). Discovery + JWKS + /authorize +
// /token all speak enough OIDC for the bo0kkeeper server + web to complete a
// login flow.
//
// Usage:
//   node scripts/dev-oidc.mjs                # blocks; port 4444, client "dev-client"
//   PORT=5555 CLIENT_ID=whatever node scripts/dev-oidc.mjs
//
// Then start the server with matching env:
//   OIDC_ISSUER=http://localhost:4444 \
//   OIDC_CLIENT_ID=dev-client \
//   OIDC_CLIENT_SECRET=dev-secret \
//   OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback \
//   pnpm --filter bo0kkeeper start:dev
import { startFakeIdp } from '../server/test/e2e/fake-idp.ts';

// Not `PORT` — the .env sets that to the bo0kkeeper server's port (2283),
// which we'd collide with.
const port = Number(process.env.DEV_OIDC_PORT ?? 4444);
const clientId = process.env.DEV_OIDC_CLIENT_ID ?? 'dev-client';

const idp = await startFakeIdp({ port, clientId });
console.log(`fake OIDC IDP up on ${idp.issuer} (client_id=${clientId})`);
console.log(`  discovery: ${idp.issuer}/.well-known/openid-configuration`);
console.log(`  jwks:      ${idp.jwksUri}`);
console.log('Ctrl-C to stop.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void idp.close().then(() => process.exit(0));
  });
}
