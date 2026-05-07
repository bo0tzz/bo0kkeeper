import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { loadConfig } from 'src/config';
import { Auth, Authenticated } from 'src/decorators';
import { AuthCallbackDto, AuthLoginDto, AuthMeDto } from 'src/dtos/auth.dto';
import { AuthService } from 'src/services/auth.service';
import { AuthUser } from 'src/types';

const ID_TOKEN_COOKIE = 'bo0kkeeper.id_token';
const STATE_COOKIE = 'bo0kkeeper.oauth_state';
const VERIFIER_COOKIE = 'bo0kkeeper.oauth_code_verifier';
const RETURN_TO_COOKIE = 'bo0kkeeper.oauth_return_to';

@Controller('/api/auth')
export class AuthController {
  private readonly cookieSecure = loadConfig().cookie.secure;
  private readonly postLoginPath = loadConfig().oidc.postLoginPath;

  constructor(private readonly authService: AuthService) {}

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
    const returnTo = req.cookies[RETURN_TO_COOKIE];

    if (!expectedState || !codeVerifier) {
      res.status(HttpStatus.BAD_REQUEST).json({ message: 'Missing OAuth state or verifier cookies' });
      return;
    }

    const callbackUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
    const { idToken } = await this.authService.exchangeCode(callbackUrl, expectedState, codeVerifier);

    const cookieOpts = { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax' as const, path: '/' };
    res.cookie(ID_TOKEN_COOKIE, idToken, cookieOpts);
    res.clearCookie(STATE_COOKIE, cookieOpts);
    res.clearCookie(VERIFIER_COOKIE, cookieOpts);
    res.clearCookie(RETURN_TO_COOKIE, cookieOpts);

    res.redirect(returnTo || this.postLoginPath);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
    @Body('post_logout_uri') postLogoutUri?: string,
  ) {
    const idToken = req.cookies[ID_TOKEN_COOKIE];
    const cookieOpts = { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax' as const, path: '/' };
    res.clearCookie(ID_TOKEN_COOKIE, cookieOpts);

    const endSessionUrl = await this.authService.getEndSessionUrl(idToken, postLogoutUri);
    res.json({ endSessionUrl });
  }

  @Get('me')
  @Authenticated()
  me(@Auth() user: AuthUser): AuthMeDto {
    return { sub: user.sub, email: user.email, name: user.name } as AuthMeDto;
  }
}
