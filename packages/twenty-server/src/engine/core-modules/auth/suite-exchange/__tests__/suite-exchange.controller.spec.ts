import { Test, type TestingModule } from '@nestjs/testing';

import { type Request, type Response } from 'express';

import {
  ThrottlerException,
  ThrottlerExceptionCode,
} from 'src/engine/core-modules/throttler/throttler.exception';

import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { SuiteExchangeService } from 'src/engine/core-modules/auth/suite-exchange/services/suite-exchange.service';
import { SuiteExchangeController } from 'src/engine/core-modules/auth/suite-exchange/suite-exchange.controller';
import { WorkspaceDomainsService } from 'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service';
import { HttpExceptionHandlerService } from 'src/engine/core-modules/exception-handler/http-exception-handler.service';
import { GuardRedirectService } from 'src/engine/core-modules/guard-redirect/services/guard-redirect.service';
import { ThrottlerService } from 'src/engine/core-modules/throttler/throttler.service';
import { UserSessionCookieService } from 'src/engine/core-modules/user-session/services/user-session-cookie.service';

const ERROR_REDIRECT_URL = 'https://crm.example.com/verify?errorMessage=nope';

describe('SuiteExchangeController', () => {
  let suiteExchangeController: SuiteExchangeController;
  let suiteExchangeService: {
    isEnabled: jest.Mock;
    exchangeForRedirectUrl: jest.Mock;
  };
  let throttlerService: { tokenBucketThrottleOrThrow: jest.Mock };
  let userSessionCookieService: { extractSessionTokenFromRequest: jest.Mock };
  let guardRedirectService: {
    getRedirectErrorUrlAndCaptureExceptions: jest.Mock;
  };

  const request = { ip: '203.0.113.7' } as Request;
  const buildResponse = () =>
    ({ redirect: jest.fn() }) as unknown as Response & {
      redirect: jest.Mock;
    };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SuiteExchangeController],
      providers: [
        {
          provide: SuiteExchangeService,
          useValue: {
            isEnabled: jest.fn().mockReturnValue(true),
            exchangeForRedirectUrl: jest
              .fn()
              .mockResolvedValue(
                'https://crm.example.com/verify?loginToken=login-token',
              ),
          },
        },
        {
          provide: ThrottlerService,
          useValue: { tokenBucketThrottleOrThrow: jest.fn() },
        },
        {
          provide: UserSessionCookieService,
          useValue: {
            extractSessionTokenFromRequest: jest
              .fn()
              .mockReturnValue(undefined),
          },
        },
        {
          provide: GuardRedirectService,
          useValue: {
            getRedirectErrorUrlAndCaptureExceptions: jest
              .fn()
              .mockReturnValue(ERROR_REDIRECT_URL),
          },
        },
        {
          provide: WorkspaceDomainsService,
          useValue: {
            getSubdomainAndCustomDomainFromWorkspaceFallbackOnDefaultSubdomain:
              jest
                .fn()
                .mockReturnValue({ subdomain: 'app', customDomain: null }),
          },
        },
        // Pulled in by the controller's @UseFilters(AuthRestApiExceptionFilter).
        {
          provide: HttpExceptionHandlerService,
          useValue: { handleError: jest.fn() },
        },
      ],
    }).compile();

    suiteExchangeController = module.get<SuiteExchangeController>(
      SuiteExchangeController,
    );
    suiteExchangeService = module.get(SuiteExchangeService);
    throttlerService = module.get(ThrottlerService);
    userSessionCookieService = module.get(UserSessionCookieService);
    guardRedirectService = module.get(GuardRedirectService);
  });

  it('redirects to the verify page with the login token', async () => {
    const response = buildResponse();

    await suiteExchangeController.exchange(
      { subject_token: 'suite-token', next: '/objects/people' },
      request,
      response,
    );

    expect(suiteExchangeService.exchangeForRedirectUrl).toHaveBeenCalledWith({
      subjectToken: 'suite-token',
      next: '/objects/people',
      presentedSessionToken: undefined,
    });
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://crm.example.com/verify?loginToken=login-token',
    );
  });

  it('forwards the session cookie the frame already carries', async () => {
    userSessionCookieService.extractSessionTokenFromRequest.mockReturnValue(
      'session-token',
    );

    await suiteExchangeController.exchange(
      { subject_token: 'suite-token' },
      request,
      buildResponse(),
    );

    expect(suiteExchangeService.exchangeForRedirectUrl).toHaveBeenCalledWith({
      subjectToken: 'suite-token',
      next: undefined,
      presentedSessionToken: 'session-token',
    });
  });

  it('redirects to the error page when the caller is rate-limited', async () => {
    throttlerService.tokenBucketThrottleOrThrow.mockRejectedValue(
      new ThrottlerException(
        'Limit reached',
        ThrottlerExceptionCode.LIMIT_REACHED,
      ),
    );

    const response = buildResponse();

    await suiteExchangeController.exchange(
      { subject_token: 'suite-token' },
      request,
      response,
    );

    expect(throttlerService.tokenBucketThrottleOrThrow).toHaveBeenCalledWith(
      'suite-exchange:203.0.113.7',
      1,
      20,
      60_000,
    );
    expect(suiteExchangeService.exchangeForRedirectUrl).not.toHaveBeenCalled();
    expect(
      guardRedirectService.getRedirectErrorUrlAndCaptureExceptions,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Too many suite exchange requests, retry in a minute',
        }),
        pathname: '/verify',
      }),
    );
    expect(response.redirect).toHaveBeenCalledWith(302, ERROR_REDIRECT_URL);
  });

  it('redirects to the error page when the feature is disabled', async () => {
    suiteExchangeService.isEnabled.mockReturnValue(false);

    const response = buildResponse();

    await suiteExchangeController.exchange(
      { subject_token: 'suite-token' },
      request,
      response,
    );

    expect(throttlerService.tokenBucketThrottleOrThrow).not.toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith(302, ERROR_REDIRECT_URL);
  });

  it('redirects to the error page when the exchange refuses the token', async () => {
    suiteExchangeService.exchangeForRedirectUrl.mockRejectedValue(
      new AuthException(
        'Suite token verification failed',
        AuthExceptionCode.FORBIDDEN_EXCEPTION,
      ),
    );

    const response = buildResponse();

    await suiteExchangeController.exchange(
      { subject_token: 'suite-token' },
      request,
      response,
    );

    expect(
      guardRedirectService.getRedirectErrorUrlAndCaptureExceptions,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Suite token verification failed',
        }),
      }),
    );
    expect(response.redirect).toHaveBeenCalledWith(302, ERROR_REDIRECT_URL);
  });

  it('rejects a body without a subject token', async () => {
    const response = buildResponse();

    await expect(
      suiteExchangeController.exchange({}, request, response),
    ).rejects.toThrow('subject_token is required');
    expect(response.redirect).not.toHaveBeenCalled();
  });

  it('drops an empty next instead of forwarding it', async () => {
    await suiteExchangeController.exchange(
      { subject_token: 'suite-token', next: '' },
      request,
      buildResponse(),
    );

    expect(suiteExchangeService.exchangeForRedirectUrl).toHaveBeenCalledWith({
      subjectToken: 'suite-token',
      next: undefined,
      presentedSessionToken: undefined,
    });
  });
});
