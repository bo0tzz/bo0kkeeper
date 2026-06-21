import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { loadConfig } from 'src/config';
import { Auth, Authenticated } from 'src/decorators';
import { AuthCallbackDto, AuthLoginDto, AuthMeDto } from 'src/dtos/auth.dto';
import { OidcRepository } from 'src/repositories/oidc.repository';
import { AuthUser } from 'src/types';

const ID_TOKEN_COOKIE = 'bo0kkeeper.id_token';
const REFRESH_TOKEN_COOKIE = 'bo0kkeeper.refresh_token';
const STATE_COOKIE = 'bo0kkeeper.oauth_state';
const VERIFIER_COOKIE = 'bo0kkeeper.oauth_code_verifier';
const RETURN_TO_COOKIE = 'bo0kkeeper.oauth_return_to';

/**
 * Path-scope the refresh-token cookie to the refresh endpoint only — the
 * browser only sends it on `/api/auth/refresh` requests, so it never
 * leaves the auth boundary on regular API traffic.
 */
const REFRESH_TOKEN_PATH = '/api/auth/refresh';

@ApiTags('Auth')
@Controller('/api/auth')
export class AuthController {
  private readonly cookieSecure = loadConfig().cookie.secure;
  private readonly postLoginPath = loadConfig().oidc.postLoginPath;

  constructor(private readonly authService: OidcRepository) {}

  @Get('login')
  async login(@Query() dto: AuthLoginDto, @Res({ passthrough: false }) res: Response) {
    const { url, state, codeVerifier } = await this.authService.buildLoginUrl();

    const cookieOpts = { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax' as const, path: '/' };
    res.cookie(STATE_COOKIE, state, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
    res.cookie(VERIFIER_COOKIE, codeVerifier, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
    if (dto.return_to) {
      res.cookie(RETURN_TO_COOKIE, dto.return_to, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
    }

    res.redirect(url);
  }

  @Get('callback')
  async callback(@Query() dto: AuthCallbackDto, @Req() req: Request, @Res({ passthrough: false }) res: Response) {
    const expectedState = req.cookies[STATE_COOKIE];
    const codeVerifier = req.cookies[VERIFIER_COOKIE];

    if (!expectedState || !codeVerifier) {
      res.status(HttpStatus.BAD_REQUEST).json({ message: 'Missing OAuth state or verifier cookies' });
      return;
    }

    const returnTo = req.cookies[RETURN_TO_COOKIE];

    const callbackUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
    const { idToken, refreshToken } = await this.authService.exchangeCode(callbackUrl, expectedState, codeVerifier);

    const cookieOpts = { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax' as const, path: '/' };
    res.cookie(ID_TOKEN_COOKIE, idToken, cookieOpts);
    if (refreshToken) {
      res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, { ...cookieOpts, path: REFRESH_TOKEN_PATH });
    }
    res.clearCookie(STATE_COOKIE, cookieOpts);
    res.clearCookie(VERIFIER_COOKIE, cookieOpts);
    res.clearCookie(RETURN_TO_COOKIE, cookieOpts);

    res.redirect(returnTo || this.postLoginPath);
  }

  /**
   * Silent refresh — the API client fires this on a 401 from any other
   * endpoint and retries the original request once on success. No
   * @Authenticated decorator: the id_token is expired by definition;
   * the refresh-token cookie (path-scoped to this endpoint) is the only
   * credential we accept here.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
  async refresh(@Req() req: Request, @Res({ passthrough: false }) res: Response) {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      res.status(HttpStatus.UNAUTHORIZED).json({ message: 'No refresh token cookie' });
      return;
    }
    try {
      const tokens = await this.authService.refreshTokens(refreshToken);
      const cookieOpts = { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax' as const, path: '/' };
      res.cookie(ID_TOKEN_COOKIE, tokens.idToken, cookieOpts);
      if (tokens.refreshToken) {
        // IDP rotated the refresh token — replace the cookie. If it didn't
        // rotate (returned null), keep the existing cookie alive.
        res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, { ...cookieOpts, path: REFRESH_TOKEN_PATH });
      }
      res.status(HttpStatus.NO_CONTENT).end();
    } catch {
      // Refresh token rejected — clear both cookies so the client falls back
      // to the login flow on the retry rather than looping on 401s.
      const baseOpts = { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax' as const };
      res.clearCookie(ID_TOKEN_COOKIE, { ...baseOpts, path: '/' });
      res.clearCookie(REFRESH_TOKEN_COOKIE, { ...baseOpts, path: REFRESH_TOKEN_PATH });
      res.status(HttpStatus.UNAUTHORIZED).json({ message: 'Refresh failed' });
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: false }) res: Response) {
    const idToken = req.cookies[ID_TOKEN_COOKIE];
    const cookieOpts = { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax' as const, path: '/' };
    res.clearCookie(ID_TOKEN_COOKIE, cookieOpts);
    res.clearCookie(REFRESH_TOKEN_COOKIE, { ...cookieOpts, path: REFRESH_TOKEN_PATH });

    // post_logout_redirect_uri is not accepted from the request: it was previously
    // an unvalidated string passed to the IDP, and the SPA never sets one anyway.
    // The IDP redirects to whatever it has registered as the default.
    const endSessionUrl = await this.authService.getEndSessionUrl(idToken);
    res.json({ endSessionUrl });
  }

  @Get('me')
  @Authenticated()
  getMe(@Auth() user: AuthUser): AuthMeDto {
    return { sub: user.sub, email: user.email, name: user.name } as AuthMeDto;
  }
}
