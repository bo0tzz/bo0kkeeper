import { DatabaseConnectionParams } from '@immich/sql-tools';
import z from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(2283),

  DB_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USERNAME: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),
  DB_DATABASE_NAME: z.string().default('bo0kkeeper'),

  OIDC_ISSUER: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.url(),
  OIDC_SCOPES: z.string().default('openid email profile'),
  /** Where to send the user after successful login (within our app). */
  OIDC_POST_LOGIN_PATH: z.string().default('/'),
  /** Cookies; non-prod can use insecure cookies. */
  COOKIE_SECURE: z.stringbool({ truthy: ['true'], falsy: ['false'] }).default(true),

  /**
   * RSA public key (PEM) for verifying Wise webhook signatures. Optional in dev
   * (paired with WISE_WEBHOOK_VERIFY=false). Required in production.
   */
  WISE_WEBHOOK_PUBLIC_KEY: z.string().optional(),
  WISE_WEBHOOK_VERIFY: z.stringbool({ truthy: ['true'], falsy: ['false'] }).default(true),
});

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  database: DatabaseConnectionParams;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    scopes: string;
    postLoginPath: string;
  };
  cookie: {
    secure: boolean;
  };
  wise: {
    /** Verify webhook signatures. False allows unsigned bodies through (dev only). */
    verifySignatures: boolean;
    /** PEM-encoded RSA public key. */
    publicKey?: string;
  };
};

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${JSON.stringify(z.treeifyError(result.error), null, 2)}`);
  }

  const database: DatabaseConnectionParams = result.data.DB_URL
    ? { connectionType: 'url', url: result.data.DB_URL }
    : {
        connectionType: 'parts',
        host: result.data.DB_HOST,
        port: result.data.DB_PORT,
        username: result.data.DB_USERNAME,
        password: result.data.DB_PASSWORD,
        database: result.data.DB_DATABASE_NAME,
      };

  return {
    nodeEnv: result.data.NODE_ENV,
    host: result.data.HOST,
    port: result.data.PORT,
    database,
    oidc: {
      issuer: result.data.OIDC_ISSUER,
      clientId: result.data.OIDC_CLIENT_ID,
      clientSecret: result.data.OIDC_CLIENT_SECRET,
      redirectUri: result.data.OIDC_REDIRECT_URI,
      scopes: result.data.OIDC_SCOPES,
      postLoginPath: result.data.OIDC_POST_LOGIN_PATH,
    },
    cookie: {
      secure: result.data.COOKIE_SECURE,
    },
    wise: {
      verifySignatures: result.data.WISE_WEBHOOK_VERIFY,
      publicKey: result.data.WISE_WEBHOOK_PUBLIC_KEY,
    },
  };
}
