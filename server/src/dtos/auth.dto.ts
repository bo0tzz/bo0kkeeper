import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const AuthLoginSchema = z.object({
  /**
   * Optional path within the app to return to after login. Same-origin
   * pathname only — leading `/` plus a non-`/` next char so that
   * protocol-relative URLs (`//evil.com`) don't slip past as "starts with /".
   * Express's `res.redirect('//evil.com')` would otherwise send the browser
   * off-origin.
   */
  return_to: z
    .string()
    .regex(/^\/($|[^/])/, { error: 'must be a same-origin path' })
    .optional(),
});
export class AuthLoginDto extends createZodDto(AuthLoginSchema) {}

const AuthCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  /** IDPs sometimes echo error in the redirect; surface it to logs. */
  error: z.string().optional(),
  error_description: z.string().optional(),
});
export class AuthCallbackDto extends createZodDto(AuthCallbackSchema) {}

const AuthMeSchema = z
  .object({
    sub: z.string(),
    email: z.string().optional(),
    name: z.string().optional(),
  })
  .meta({ id: 'AuthMeDto' });
export class AuthMeDto extends createZodDto(AuthMeSchema) {}
