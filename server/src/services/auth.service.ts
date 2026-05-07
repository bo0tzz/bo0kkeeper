import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose';
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientSecretBasic,
  Configuration,
  discovery,
  None,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import { Config, loadConfig } from 'src/config';
import { AuthUser } from 'src/types';

type DiscoveredClient = Configuration;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly oidcConfig: Config['oidc'];
  private clientPromise?: Promise<DiscoveredClient>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor() {
    this.oidcConfig = loadConfig().oidc;
  }

  /**
   * Build the IDP authorization URL plus a one-time `state` and PKCE `codeVerifier`.
   * Caller is responsible for storing both in short-lived cookies and verifying on callback.
   */
  async buildLoginUrl(): Promise<{ url: string; state: string; codeVerifier: string }> {
    const client = await this.getClient();
    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

    const url = buildAuthorizationUrl(client, {
      redirect_uri: this.oidcConfig.redirectUri,
      scope: this.oidcConfig.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();

    return { url, state, codeVerifier };
  }

  /**
   * Exchange the authorization code for tokens, validating state and PKCE.
   * Returns the raw ID token (a JWT) for storage in an HttpOnly cookie.
   */
  async exchangeCode(callbackUrl: URL, expectedState: string, codeVerifier: string): Promise<{ idToken: string }> {
    const client = await this.getClient();
    try {
      const tokens = await authorizationCodeGrant(client, callbackUrl, {
        expectedState,
        pkceCodeVerifier: codeVerifier,
      });
      if (!tokens.id_token) {
        throw new Error('IDP did not return an id_token');
      }
      return { idToken: tokens.id_token };
    } catch (error: unknown) {
      this.logger.error(`OAuth callback failed: ${(error as Error).message}`);
      throw new UnauthorizedException('OAuth login failed');
    }
  }

  /**
   * Verify an ID token against the IDP's JWKS and expected issuer/audience.
   * Returns the user identity on success.
   */
  async verifyIdToken(idToken: string): Promise<AuthUser> {
    const jwks = await this.getJwks();
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(idToken, jwks, {
        issuer: this.oidcConfig.issuer,
        audience: this.oidcConfig.clientId,
        clockTolerance: '5s',
      });
      payload = result.payload;
    } catch (error: unknown) {
      this.logger.debug(`ID token verification failed: ${(error as Error).message}`);
      throw new UnauthorizedException();
    }

    if (!payload.sub) {
      throw new UnauthorizedException();
    }

    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }

  /** End-session URL (RP-initiated logout) if the IDP advertises one. */
  async getEndSessionUrl(idTokenHint?: string, postLogoutRedirectUri?: string): Promise<string | null> {
    const client = await this.getClient();
    const meta = client.serverMetadata();
    if (!meta.end_session_endpoint) {
      return null;
    }
    const url = new URL(meta.end_session_endpoint);
    if (idTokenHint) {
      url.searchParams.set('id_token_hint', idTokenHint);
    }
    if (postLogoutRedirectUri) {
      url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    }
    return url.toString();
  }

  private getClient(): Promise<DiscoveredClient> {
    if (!this.clientPromise) {
      this.clientPromise = discovery(
        new URL(this.oidcConfig.issuer),
        this.oidcConfig.clientId,
        { client_secret: this.oidcConfig.clientSecret, response_types: ['code'] },
        this.oidcConfig.clientSecret ? ClientSecretBasic(this.oidcConfig.clientSecret) : None(),
      ).catch((error: unknown) => {
        this.clientPromise = undefined;
        this.logger.error(`OIDC discovery failed: ${(error as Error).message}`);
        throw error;
      });
    }
    return this.clientPromise;
  }

  private async getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (this.jwks) {
      return this.jwks;
    }
    const client = await this.getClient();
    const jwksUri = client.serverMetadata().jwks_uri;
    if (!jwksUri) {
      throw new Error('IDP does not advertise a jwks_uri');
    }
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
    return this.jwks;
  }
}
