import { type NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { json, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type WithRawBody = Express.Request & { rawBody?: string };

export function applyCommonAppConfig(app: NestExpressApplication) {
  // Trust the immediate upstream proxy (k8s Ingress / Envoy) so `req.protocol`
  // reflects the public-facing scheme, not the in-cluster HTTP hop. Critical
  // for OAuth: the callback constructs the redirect_uri it sends to the IDP
  // token endpoint from `req.protocol`. Without trust-proxy the IDP sees
  // http:// while the registered URI is https:// → invalid_grant. In dev
  // (no proxy) the header is absent and Express falls back to the connection
  // protocol — safe no-op.
  app.set('trust proxy', 1);

  app.use(cookieParser());
  app.use(compression());
  app.use(
    helmet({
      // The SvelteKit static SPA needs to load its own JS/CSS; CSP will be tightened in a later phase.
      contentSecurityPolicy: false,
    }),
  );
  app.disable('x-powered-by');

  // Capture raw body alongside the parsed JSON for routes that verify signatures
  // (Wise/paperless webhooks). Without this, signature verification gets the
  // re-serialized body, which won't match Wise's signature byte-for-byte.
  app.use(
    json({
      verify: (req, _res, buf: Buffer) => {
        (req as WithRawBody).rawBody = buf.toString('utf8');
      },
    }),
  );
}

/**
 * Serve the SvelteKit static build from the given directory + add the SPA
 * index.html fallback for unknown GET routes. `/api/*` routes are handled by
 * NestJS controllers (registered before this middleware) and aren't affected.
 *
 * SvelteKit emits pre-compressed `.gz` / `.br` next to each asset (we set
 * `precompress: true` in svelte.config.js). The `setHeaders` callback adds
 * `Cache-Control` for hashed assets in `_app/immutable/` — these are
 * content-addressed by SvelteKit and safe to cache aggressively.
 */
export function serveWebStatic(app: NestExpressApplication, webDist: string): void {
  app.useStaticAssets(webDist, {
    fallthrough: true,
    setHeaders: (res, path) => {
      if (path.includes(`${webDist}/_app/immutable/`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });
  const indexHtml = join(webDist, 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Error(`WEB_DIST_DIR=${webDist} contains no index.html`);
  }
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    // API routes always handled by Nest controllers; never fall through to
    // index.html. The auth/webhook routes also live under /api.
    if (req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(indexHtml);
  });
}
