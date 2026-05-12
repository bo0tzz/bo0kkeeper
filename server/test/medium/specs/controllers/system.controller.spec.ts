import { SystemController } from 'src/controllers/system.controller';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('SystemController', () => {
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

  it('reports the active cutover date and ingestionEnabled=true when set', () => {
    process.env.CUTOVER_DATE = '2026-05-01';
    const result = new SystemController({} as never, {} as never).getInfo();
    expect(result).toEqual({ cutoverDate: '2026-05-01', ingestionEnabled: true });
  });

  it('reports cutoverDate=null and ingestionEnabled=false when unset', () => {
    delete process.env.CUTOVER_DATE;
    const result = new SystemController({} as never, {} as never).getInfo();
    expect(result).toEqual({ cutoverDate: null, ingestionEnabled: false });
  });
});
