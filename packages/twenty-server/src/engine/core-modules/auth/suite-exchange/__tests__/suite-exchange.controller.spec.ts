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
import {
  SUITE_EXCHANGE_RATE_LIMIT_MAX,
  SUITE_EXCHANGE_RATE_LIMIT_WINDOW_MS,
} from 'src/engine/core-modules/auth/suite-exchange/constants/suite-exchange-rate-limit.constants';
import { SUITE_EXCHANGE_MAX_SUBJECT_TOKEN_LENGTH } from 'src/engine/core-modules/auth/suite-exchange/constants/suite-exchange-subject-token.constants';
import { SuiteExchangeService } from 'src/engine/core-modules/auth/suite-exchange/services/suite-exchange.service';
import { SuiteExchangeController } from 'src/engine/core-modules/auth/suite-exchange/suite-exchange.controller';
import { WorkspaceDomainsService } from 'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service';
import { HttpExceptionHandlerService } from 'src/engine/core-modules/exception-handler/http-exception-handler.service';
import { GuardRedirectService } from 'src/engine/core-modules/guard-redirect/services/guard-redirect.service';
import { ThrottlerService } from 'src/engine/core-modules/throttler/throttler.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { UserSessionCookieService } from 'src/engine/core-modules/user-session/services/user-session-cookie.service';

const ERROR_REDIRECT_URL = 'https://crm.example.com/verify?errorMessage=nope';
const SUITE_HOST_ORIGIN = 'https://suite.example.com';

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

  let configValues: Record<string, unknown>;

  const buildRequest = (origin?: string) =>
    ({
      ip: '203.0.113.7',
      headers: { origin },
    }) as unknown as Request;
  const request = buildRequest(SUITE_HOST_ORIGIN);
  const buildResponse = () =>
    ({ redirect: jest.fn() }) as unknown as Response & {
      redirect: jest.Mock;
    };

  beforeEach(async () => {
    configValues = { SUITE_HOST_ORIGIN };

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
        {
          provide: TwentyConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
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
      SUITE_EXCHANGE_RATE_LIMIT_MAX,
      SUITE_EXCHANGE_RATE_LIMIT_WINDOW_MS,
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

  it('redirects to the error page without spending a throttle token when the subject token is oversized', async () => {
    const response = buildResponse();

    await suiteExchangeController.exchange(
      {
        subject_token: 'a'.repeat(SUITE_EXCHANGE_MAX_SUBJECT_TOKEN_LENGTH + 1),
      },
      request,
      response,
    );

    expect(throttlerService.tokenBucketThrottleOrThrow).not.toHaveBeenCalled();
    expect(suiteExchangeService.exchangeForRedirectUrl).not.toHaveBeenCalled();
    expect(
      guardRedirectService.getRedirectErrorUrlAndCaptureExceptions,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'subject_token is too long',
        }),
        pathname: '/verify',
      }),
    );
    expect(response.redirect).toHaveBeenCalledWith(302, ERROR_REDIRECT_URL);
  });

  it('accepts a subject token that is exactly at the length ceiling', async () => {
    await suiteExchangeController.exchange(
      { subject_token: 'a'.repeat(SUITE_EXCHANGE_MAX_SUBJECT_TOKEN_LENGTH) },
      request,
      buildResponse(),
    );

    expect(suiteExchangeService.exchangeForRedirectUrl).toHaveBeenCalled();
  });

  it('redirects to the error page without spending a throttle token when the origin is missing', async () => {
    const response = buildResponse();

    await suiteExchangeController.exchange(
      { subject_token: 'suite-token' },
      buildRequest(),
      response,
    );

    expect(throttlerService.tokenBucketThrottleOrThrow).not.toHaveBeenCalled();
    expect(suiteExchangeService.exchangeForRedirectUrl).not.toHaveBeenCalled();
    expect(
      guardRedirectService.getRedirectErrorUrlAndCaptureExceptions,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Suite exchange must be posted from the suite host',
        }),
      }),
    );
    expect(response.redirect).toHaveBeenCalledWith(302, ERROR_REDIRECT_URL);
  });

  it('redirects to the error page when the origin is not the suite host', async () => {
    const response = buildResponse();

    await suiteExchangeController.exchange(
      { subject_token: 'suite-token' },
      buildRequest('https://evil.example.com'),
      response,
    );

    expect(throttlerService.tokenBucketThrottleOrThrow).not.toHaveBeenCalled();
    expect(suiteExchangeService.exchangeForRedirectUrl).not.toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith(302, ERROR_REDIRECT_URL);
  });

  it('accepts the suite host origin however the configured value is spelled', async () => {
    configValues.SUITE_HOST_ORIGIN = 'https://suite.example.com/';

    const response = buildResponse();

    await suiteExchangeController.exchange(
      { subject_token: 'suite-token' },
      buildRequest(SUITE_HOST_ORIGIN),
      response,
    );

    expect(suiteExchangeService.exchangeForRedirectUrl).toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://crm.example.com/verify?loginToken=login-token',
    );
  });

  it('hides an unexpected error behind a generic message', async () => {
    suiteExchangeService.exchangeForRedirectUrl.mockRejectedValue(
      new Error(
        'duplicate key value violates unique constraint "UQ_USER_EMAIL"',
      ),
    );

    const response = buildResponse();

    await suiteExchangeController.exchange(
      { subject_token: 'suite-token' },
      request,
      response,
    );

    const { error } =
      guardRedirectService.getRedirectErrorUrlAndCaptureExceptions.mock
        .calls[0][0];

    expect(error).toBeInstanceOf(AuthException);
    expect(error.code).toBe(AuthExceptionCode.INTERNAL_SERVER_ERROR);
    expect(error.message).toBe('Suite token exchange failed');
    expect(error.message).not.toContain('UQ_USER_EMAIL');
    expect(error.cause).toEqual(
      expect.objectContaining({
        message:
          'duplicate key value violates unique constraint "UQ_USER_EMAIL"',
      }),
    );
    expect(response.redirect).toHaveBeenCalledWith(302, ERROR_REDIRECT_URL);
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
