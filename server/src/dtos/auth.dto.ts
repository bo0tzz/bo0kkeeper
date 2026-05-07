import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const AuthLoginSchema = z.object({
  /** Optional path within the app to return to after login. */
  return_to: z.string().startsWith('/').optional(),
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
