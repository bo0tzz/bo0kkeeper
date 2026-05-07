import { type NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';

type WithRawBody = Express.Request & { rawBody?: string };

export function applyCommonAppConfig(app: NestExpressApplication) {
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
