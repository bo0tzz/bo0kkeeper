import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Request } from 'express';
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
