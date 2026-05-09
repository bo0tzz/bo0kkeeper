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
  OIDC_SCOPES: z.string().default('openid email profile offline_access'),
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

  /** Wise REST API base. Sandbox: https://api.sandbox.transferwise.tech */
  WISE_API_BASE_URL: z.url().default('https://api.transferwise.com'),
  /** Personal API token. Required to draft transfers; optional otherwise. */
  WISE_API_TOKEN: z.string().optional(),
  /** Numeric Wise profile id (business profile). */
  WISE_PROFILE_ID: z.coerce.number().int().positive().optional(),
  /** Recipient id of the user's Dutch bank account in Wise. */
  WISE_TARGET_RECIPIENT_ID: z.coerce.number().int().positive().optional(),
  /**
   * Starting offset for the `TXN-NNNN` reference sequence. The user's existing
   * sheet is at TXN-0001 at go-live; the system continues from this number.
   */
  WISE_TXN_REFERENCE_START: z.coerce.number().int().nonnegative().default(0),

  /** Paperless-ngx base URL, e.g. `https://paperless.lan` (no trailing slash). */
  PAPERLESS_BASE_URL: z.url().optional(),
  /** Paperless API token (from `/admin/` user profile). */
  PAPERLESS_TOKEN: z.string().optional(),
  /**
   * Shared secret expected on inbound paperless workflow webhooks. The workflow
   * is configured in paperless-ngx to send `Authorization: Bearer <token>`.
   * When set, requests without a matching header are rejected.
   */
  PAPERLESS_WEBHOOK_TOKEN: z.string().optional(),
  /**
   * Enable Banking application id (UUID, registered at enablebanking.com/cp).
   * Used as JWT `kid`. Optional in dev — services that need it throw at call time.
   */
  ENABLE_BANKING_APP_ID: z.uuid().optional(),
  /** RSA private key (PEM) downloaded at app registration; signs request JWTs. */
  ENABLE_BANKING_PRIVATE_KEY: z.string().optional(),
  /** API base. Same host serves prod + sandbox; environments differ by registered ASPSPs. */
  ENABLE_BANKING_API_BASE_URL: z.url().default('https://api.enablebanking.com'),
  /** Public callback URL the bank redirects back to after PSU consent. */
  ENABLE_BANKING_REDIRECT_URI: z.url().optional(),

  /**
   * System-wide cutover date — every live ingestion path drops events whose
   * own date is before this floor: Wise webhooks (occurredAt), paperless
   * webhooks (created), bank-tx sync (txDate). When unset, ingestion is
   * disabled entirely so a freshly-deployed system can't start eating
   * pre-go-live data before the operator's set things up. ISO YYYY-MM-DD.
   */
  CUTOVER_DATE: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Expected ISO YYYY-MM-DD' })
    .optional(),

  /** Google Sheets service-account email (e.g. `bookkeeper@project.iam.gserviceaccount.com`). */
  SHEETS_SERVICE_ACCOUNT_EMAIL: z.email().optional(),
  /** PEM-encoded RSA private key for the service account. */
  SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().optional(),
  /** Spreadsheet id (the long string in the gdrive URL). */
  SHEETS_SPREADSHEET_ID: z.string().optional(),
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
    /** REST API base URL. */
    apiBaseUrl: string;
    /** Personal API token, when set. */
    apiToken?: string;
    /** Numeric Wise profile id. */
    profileId?: number;
    /** Wise recipient id for the target Dutch bank account. */
    targetRecipientId?: number;
    /** Starting offset for `TXN-NNNN` references issued by this system. */
    txnReferenceStart: number;
  };
  paperless: {
    baseUrl?: string;
    token?: string;
    webhookToken?: string;
  };
  enableBanking: {
    /** Application id (used as JWT `kid`). Required at call-time, optional at boot. */
    appId?: string;
    /** PEM-encoded RSA private key. Required at call-time. */
    privateKey?: string;
    apiBaseUrl: string;
    /** Public callback URL bank redirects to. Required to start auth. */
    redirectUri?: string;
  };
  /**
   * System-wide cutover floor as ISO YYYY-MM-DD. Every ingest path drops
   * events older than this. Unset = ingestion disabled (intentional safety
   * net for fresh deployments).
   */
  cutoverDate?: string;
  sheets: {
    serviceAccountEmail?: string;
    serviceAccountPrivateKey?: string;
    spreadsheetId?: string;
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
      apiBaseUrl: result.data.WISE_API_BASE_URL,
      apiToken: result.data.WISE_API_TOKEN,
      profileId: result.data.WISE_PROFILE_ID,
      targetRecipientId: result.data.WISE_TARGET_RECIPIENT_ID,
      txnReferenceStart: result.data.WISE_TXN_REFERENCE_START,
    },
    paperless: {
      baseUrl: result.data.PAPERLESS_BASE_URL,
      token: result.data.PAPERLESS_TOKEN,
      webhookToken: result.data.PAPERLESS_WEBHOOK_TOKEN,
    },
    enableBanking: {
      appId: result.data.ENABLE_BANKING_APP_ID,
      privateKey: result.data.ENABLE_BANKING_PRIVATE_KEY,
      apiBaseUrl: result.data.ENABLE_BANKING_API_BASE_URL,
      redirectUri: result.data.ENABLE_BANKING_REDIRECT_URI,
    },
    cutoverDate: result.data.CUTOVER_DATE,
    sheets: {
      serviceAccountEmail: result.data.SHEETS_SERVICE_ACCOUNT_EMAIL,
      serviceAccountPrivateKey: result.data.SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY,
      spreadsheetId: result.data.SHEETS_SPREADSHEET_ID,
    },
  };
}
