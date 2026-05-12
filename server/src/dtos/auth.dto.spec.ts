import { AuthLoginDto } from 'src/dtos/auth.dto';
import { describe, expect, it } from 'vitest';

const parseReturnTo = (return_to?: string) => AuthLoginDto.schema.safeParse({ return_to });

describe('AuthLoginDto.return_to', () => {
  it('accepts a same-origin pathname', () => {
    expect(parseReturnTo('/').success).toBe(true);
    expect(parseReturnTo('/dashboard').success).toBe(true);
    expect(parseReturnTo('/banking?tab=consents').success).toBe(true);
  });

  it('accepts no return_to', () => {
    expect(parseReturnTo().success).toBe(true);
  });

  it('rejects protocol-relative URLs (open-redirect via Location header)', () => {
    expect(parseReturnTo('//evil.com').success).toBe(false);
    expect(parseReturnTo('//evil.com/path').success).toBe(false);
    expect(parseReturnTo('///evil.com').success).toBe(false);
  });

  it('rejects absolute URLs', () => {
    expect(parseReturnTo('https://evil.com').success).toBe(false);
    expect(parseReturnTo('http://localhost:3000/dashboard').success).toBe(false);
    expect(parseReturnTo('javascript:alert(1)').success).toBe(false);
  });

  it('rejects bare paths without a leading slash', () => {
    expect(parseReturnTo('dashboard').success).toBe(false);
    expect(parseReturnTo('').success).toBe(false);
  });
});
