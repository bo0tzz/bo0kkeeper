import { loadConfig } from 'src/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Production must refuse to boot when either webhook endpoint would accept
 * unauthenticated traffic. Both endpoints are publicly reachable in deployment;
 * the refinement is the only thing standing between "operator typo" and
 * "anyone can forge transfer-state-change events".
 */
describe('loadConfig — production webhook auth refinements', () => {
  const snapshot: Record<string, string | undefined> = {};
  const keys = [
    'NODE_ENV',
    'WISE_WEBHOOK_VERIFY',
    'WISE_WEBHOOK_PUBLIC_KEY',
    'PAPERLESS_WEBHOOK_TOKEN',
    'OIDC_ISSUER',
    'OIDC_CLIENT_ID',
    'OIDC_REDIRECT_URI',
  ];

  beforeEach(() => {
    for (const k of keys) {
      snapshot[k] = process.env[k];
    }
    // Required OIDC vars so the rest of the schema parses cleanly.
    process.env.OIDC_ISSUER = 'http://idp.test';
    process.env.OIDC_CLIENT_ID = 'test';
    process.env.OIDC_REDIRECT_URI = 'http://localhost/callback';
  });

  afterEach(() => {
    for (const k of keys) {
      if (snapshot[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = snapshot[k];
      }
    }
  });

  it('refuses to boot in production when WISE_WEBHOOK_VERIFY=false', () => {
    process.env.NODE_ENV = 'production';
    process.env.WISE_WEBHOOK_VERIFY = 'false';
    process.env.PAPERLESS_WEBHOOK_TOKEN = 'set';
    expect(() => loadConfig()).toThrow(/WISE_WEBHOOK_VERIFY/);
  });

  it('refuses to boot in production when WISE_WEBHOOK_PUBLIC_KEY is unset', () => {
    process.env.NODE_ENV = 'production';
    process.env.WISE_WEBHOOK_VERIFY = 'true';
    delete process.env.WISE_WEBHOOK_PUBLIC_KEY;
    process.env.PAPERLESS_WEBHOOK_TOKEN = 'set';
    expect(() => loadConfig()).toThrow(/WISE_WEBHOOK_VERIFY/);
  });

  it('refuses to boot in production when PAPERLESS_WEBHOOK_TOKEN is unset', () => {
    process.env.NODE_ENV = 'production';
    process.env.WISE_WEBHOOK_VERIFY = 'true';
    process.env.WISE_WEBHOOK_PUBLIC_KEY = 'pretend-pem';
    delete process.env.PAPERLESS_WEBHOOK_TOKEN;
    expect(() => loadConfig()).toThrow(/PAPERLESS_WEBHOOK_TOKEN/);
  });

  it('boots in production when both webhook auths are configured', () => {
    process.env.NODE_ENV = 'production';
    process.env.WISE_WEBHOOK_VERIFY = 'true';
    process.env.WISE_WEBHOOK_PUBLIC_KEY = 'pretend-pem';
    process.env.PAPERLESS_WEBHOOK_TOKEN = 'set';
    expect(() => loadConfig()).not.toThrow();
  });

  it('allows the dev bypass in non-production', () => {
    process.env.NODE_ENV = 'development';
    process.env.WISE_WEBHOOK_VERIFY = 'false';
    delete process.env.WISE_WEBHOOK_PUBLIC_KEY;
    delete process.env.PAPERLESS_WEBHOOK_TOKEN;
    expect(() => loadConfig()).not.toThrow();
  });
});
