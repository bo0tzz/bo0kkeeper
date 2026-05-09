import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCutover } from 'src/utils/cutover';

describe('checkCutover', () => {
  // OIDC vars are required by loadConfig() — set permissively so we can vary
  // CUTOVER_DATE without tripping the schema.
  const originalCutover = process.env.CUTOVER_DATE;

  beforeEach(() => {
    process.env.OIDC_ISSUER ??= 'http://idp.test';
    process.env.OIDC_CLIENT_ID ??= 'test';
    process.env.OIDC_REDIRECT_URI ??= 'http://localhost/callback';
  });

  afterEach(() => {
    if (originalCutover === undefined) {
      delete process.env.CUTOVER_DATE;
    } else {
      process.env.CUTOVER_DATE = originalCutover;
    }
  });

  it('rejects every event when CUTOVER_DATE is unset', () => {
    delete process.env.CUTOVER_DATE;
    const decision = checkCutover(new Date('2030-01-01'));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('no_cutover_configured');
    }
  });

  it('rejects events whose date is before the cutover floor', () => {
    process.env.CUTOVER_DATE = '2026-05-01';
    const decision = checkCutover(new Date('2026-04-30T23:59:59Z'));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('before_cutover');
    }
  });

  it('allows events on or after the cutover date', () => {
    process.env.CUTOVER_DATE = '2026-05-01';
    expect(checkCutover(new Date('2026-05-01T00:00:00Z')).allowed).toBe(true);
    expect(checkCutover(new Date('2030-01-01')).allowed).toBe(true);
  });
});
