import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';

import { isNonEmptyString } from '@sniptt/guards';
import { type Request, type Response } from 'express';
import { ApiPath, AppPath } from 'twenty-shared/types';

import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { AuthRestApiExceptionFilter } from 'src/engine/core-modules/auth/filters/auth-rest-api-exception.filter';
import {
  SUITE_EXCHANGE_RATE_LIMIT_MAX,
  SUITE_EXCHANGE_RATE_LIMIT_WINDOW_MS,
} from 'src/engine/core-modules/auth/suite-exchange/constants/suite-exchange-rate-limit.constants';
import { SUITE_EXCHANGE_MAX_SUBJECT_TOKEN_LENGTH } from 'src/engine/core-modules/auth/suite-exchange/constants/suite-exchange-subject-token.constants';
import { SuiteExchangeService } from 'src/engine/core-modules/auth/suite-exchange/services/suite-exchange.service';
import { isSuiteHostOrigin } from 'src/engine/core-modules/auth/suite-exchange/utils/is-suite-host-origin.util';
import { WorkspaceDomainsService } from 'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service';
import { GuardRedirectService } from 'src/engine/core-modules/guard-redirect/services/guard-redirect.service';
import { ThrottlerException } from 'src/engine/core-modules/throttler/throttler.exception';
import { ThrottlerService } from 'src/engine/core-modules/throttler/throttler.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { UserSessionCookieService } from 'src/engine/core-modules/user-session/services/user-session-cookie.service';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { PublicEndpointGuard } from 'src/engine/guards/public-endpoint.guard';

// snake_case on purpose: RFC 8693 vocabulary, confined to this wire type.
type SuiteExchangeBody = {
  subject_token?: string;
  next?: string;
};

@Controller(ApiPath.Auth)
@UseFilters(AuthRestApiExceptionFilter)
export class SuiteExchangeController {
  constructor(
    private readonly suiteExchangeService: SuiteExchangeService,
    private readonly throttlerService: ThrottlerService,
    private readonly userSessionCookieService: UserSessionCookieService,
    private readonly guardRedirectService: GuardRedirectService,
    private readonly workspaceDomainsService: WorkspaceDomainsService,
    private readonly twentyConfigService: TwentyConfigService,
  ) {}

  @Post('suite/exchange')
  @UseGuards(PublicEndpointGuard, NoPermissionGuard)
  async exchange(
    @Body() body: SuiteExchangeBody,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!isNonEmptyString(body?.subject_token)) {
      // The one failure that is not a user-facing path: the host page did not
      // post a token at all, so there is nobody to show an error page to.
      throw new AuthException(
        'subject_token is required',
        AuthExceptionCode.INVALID_INPUT,
      );
    }

    try {
      // Duplicated in the service, which is the check that matters for
      // correctness: this one only keeps a disabled instance from spending a
      // throttle token and from being probed through the Origin check.
      if (!this.suiteExchangeService.isEnabled()) {
        throw new AuthException(
          'Suite token exchange is disabled',
          AuthExceptionCode.FORBIDDEN_EXCEPTION,
        );
      }

      if (body.subject_token.length > SUITE_EXCHANGE_MAX_SUBJECT_TOKEN_LENGTH) {
        throw new AuthException(
          'subject_token is too long',
          AuthExceptionCode.INVALID_INPUT,
        );
      }

      this.assertPostedFromSuiteHost(req);

      await this.throttleOrThrow(req);

      const redirectUrl =
        await this.suiteExchangeService.exchangeForRedirectUrl({
          subjectToken: body.subject_token,
          next: isNonEmptyString(body.next) ? body.next : undefined,
          presentedSessionToken:
            this.userSessionCookieService.extractSessionTokenFromRequest(req),
        });

      return res.redirect(302, redirectUrl);
    } catch (error) {
      // The response is rendered by the iframe, so an error body would replace
      // the CRM with raw JSON the user cannot act on.
      return res.redirect(
        302,
        this.guardRedirectService.getRedirectErrorUrlAndCaptureExceptions({
          error: this.toRedirectableError(error),
          // A deployment serves one workspace and single-workspace mode ignores
          // the subdomain, so the fallback resolves to the same front URL.
          workspace:
            this.workspaceDomainsService.getSubdomainAndCustomDomainFromWorkspaceFallbackOnDefaultSubdomain(),
          pathname: AppPath.Verify,
        }),
      );
    }
  }

  // Anything that is not an AuthException reaches the browser verbatim, as
  // `Authentication error: <message>` in ?errorMessage=: the QueryFailedError
  // two tabs race into on a first exchange would name the constraint and the
  // table it failed on. INTERNAL_SERVER_ERROR is also the only code
  // GuardRedirectService reports, and the original travels on `cause`, which
  // the exception handler reads.
  private toRedirectableError(error: unknown): AuthException {
    if (error instanceof AuthException) {
      return error;
    }

    return Object.assign(
      new AuthException(
        'Suite token exchange failed',
        AuthExceptionCode.INTERNAL_SERVER_ERROR,
      ),
      { cause: error },
    );
  }

  // Fails closed on a missing Origin, like CookieSessionCsrfMiddleware:
  // browsers send it on every cross-origin POST, so its absence is either a
  // non-browser client or a stripped header we cannot tell from a forgery.
  // Without it any page holding a valid suite token could log a victim's
  // browser into the attacker's Twenty user.
  private assertPostedFromSuiteHost(req: Request): void {
    if (
      !isSuiteHostOrigin({
        origin: req.headers.origin,
        allowedOrigin: this.twentyConfigService.get('SUITE_HOST_ORIGIN'),
      })
    ) {
      throw new AuthException(
        'Suite exchange must be posted from the suite host',
        AuthExceptionCode.FORBIDDEN_EXCEPTION,
      );
    }
  }

  private async throttleOrThrow(req: Request): Promise<void> {
    try {
      await this.throttlerService.tokenBucketThrottleOrThrow(
        `suite-exchange:${req.ip}`,
        1,
        SUITE_EXCHANGE_RATE_LIMIT_MAX,
        SUITE_EXCHANGE_RATE_LIMIT_WINDOW_MS,
      );
    } catch (error) {
      if (error instanceof ThrottlerException) {
        // AuthExceptionCode has no throttling member, and the code no longer
        // picks a status now that every failure redirects: the message is what
        // the error page shows.
        throw new AuthException(
          'Too many suite exchange requests, retry in a minute',
          AuthExceptionCode.FORBIDDEN_EXCEPTION,
        );
      }

      throw error;
    }
  }
}
