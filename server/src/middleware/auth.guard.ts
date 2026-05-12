import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { MetadataKey } from 'src/constants';
import { AuthRouteOptions } from 'src/decorators';
import { OidcRepository } from 'src/repositories/oidc.repository';

const ID_TOKEN_COOKIE = 'bo0kkeeper.id_token';

/**
 * Routes are public unless decorated with `@Authenticated()`.
 * For protected routes the guard verifies the ID-token cookie against the IDP's JWKS
 * and attaches the resolved user to `request.user`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: OidcRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<AuthRouteOptions | undefined>(MetadataKey.AuthRoute, context.getHandler());
    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const idToken = request.cookies?.[ID_TOKEN_COOKIE];
    if (!idToken) {
      throw new UnauthorizedException();
    }

    const user = await this.authService.verifyIdToken(idToken);
    (request as Request & { user?: typeof user }).user = user;
    return true;
  }
}
