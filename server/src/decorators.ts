import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { Request } from 'express';
import { type ZodDto } from 'nestjs-zod';
import { MetadataKey } from 'src/constants';
import { JobName, QueueName } from 'src/enum';
import { AuthUser } from 'src/types';

export type AuthRouteOptions = {
  /** When set, the IDP must have granted these permission claims. */
  permission?: string;
};

/**
 * Mark a route as requiring authentication. Routes without this decorator are public.
 * `AuthGuard` enforces by checking the ID token cookie and attaching `request.user`.
 */
export const Authenticated = (options: AuthRouteOptions = {}): MethodDecorator =>
  applyDecorators(SetMetadata(MetadataKey.AuthRoute, options));

/** Param decorator: pull the verified `AuthUser` out of the request. */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  if (!request.user) {
    throw new Error('@Auth() used on a route without @Authenticated() — request.user is unset');
  }
  return request.user;
});

export type JobConfig = {
  name: JobName;
  queue: QueueName;
};

/**
 * Mark a service method as a job handler. Discovered at startup; every JobName must have
 * exactly one handler. Real wiring lands in Phase 0g (pg-boss).
 */
export const OnJob = (config: JobConfig): MethodDecorator => SetMetadata(MetadataKey.JobConfig, config);

/**
 * Walk a Zod query DTO and emit a `@ApiQuery` decorator per top-level field
 * so the generated OpenAPI spec carries the parameter list. Without this,
 * `@Query() dto: SomeDto` produces an empty `parameters: []` in the spec —
 * `nestjs-zod`'s OpenAPI patch only handles request-body schemas.
 *
 * Usage:
 *   `@Get()`
 *   `@ApiQueryFromDto(SomeQueryDto)`
 *   `async list(@Query() query: SomeQueryDto): Promise<...>`
 *
 * Caveats: only handles flat object schemas at the top level. `optional()` or
 * `default(...)` on a field marks it `required: false` in the spec.
 */
export const ApiQueryFromDto = (dto: ZodDto): MethodDecorator & ClassDecorator => {
  const schema = dto.schema as { shape?: Record<string, unknown> };
  const shape = schema.shape;
  if (!shape) {
    return applyDecorators();
  }

  const decorators: (MethodDecorator & ClassDecorator)[] = [];
  for (const [name, field] of Object.entries(shape)) {
    decorators.push(
      ApiQuery({
        name,
        required: !isOptionalField(field),
        // We don't translate Zod v4 schemas to OpenAPI types here — the SDK
        // ends up with `any` for query params, which is fine for our use.
        // The point of this decorator is to surface the param NAMES so they
        // appear in the spec at all (without it, parameters[] is empty).
        schema: { type: 'string' },
      }) as MethodDecorator & ClassDecorator,
    );
  }
  return applyDecorators(...decorators);
};

function isOptionalField(field: unknown): boolean {
  // Zod 4: `field.def.type === 'optional' | 'default'` when the field has been
  // wrapped. Fall back to the legacy `_def.typeName` for compatibility with
  // anything still on the v3 path.
  const def =
    (field as { def?: { type?: string }; _def?: { typeName?: string } }).def ??
    (field as { _def?: { typeName?: string } })._def;
  if (!def) {
    return false;
  }
  if ('type' in def && def.type !== undefined) {
    return def.type === 'optional' || def.type === 'default';
  }
  if ('typeName' in def && def.typeName !== undefined) {
    return def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault';
  }
  return false;
}
