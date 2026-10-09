import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { type Repository } from 'typeorm';

import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { SignInUpService } from 'src/engine/core-modules/auth/services/sign-in-up.service';
import { SuiteUserIdentityEntity } from 'src/engine/core-modules/auth/suite-exchange/entities/suite-user-identity.entity';
import { SuiteExchangeService } from 'src/engine/core-modules/auth/suite-exchange/services/suite-exchange.service';
import { SuiteTokenVerifierService } from 'src/engine/core-modules/auth/suite-exchange/services/suite-token-verifier.service';
import { LoginTokenService } from 'src/engine/core-modules/auth/token/services/login-token.service';
import { JwtTokenTypeEnum } from 'src/engine/core-modules/auth/types/jwt-token-type.enum';
import { WorkspaceDomainsService } from 'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service';
import { OnboardingService } from 'src/engine/core-modules/onboarding/onboarding.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { UserService } from 'src/engine/core-modules/user/services/user.service';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { UserSessionService } from 'src/engine/core-modules/user-session/services/user-session.service';
import { AuthProviderEnum } from 'src/engine/core-modules/workspace/types/workspace.type';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

const SUITE_ISSUER = 'https://suite.example.com';
const SUITE_WORKSPACE_ID = '20202020-1c25-4d02-bf25-6aeccf7ea419';
const SUITE_ORGANIZATION_ID = '30303030-1c25-4d02-bf25-6aeccf7ea419';
const WORKSPACE_URL = 'https://crm.example.com/';

const CLAIMS = {
  subject: 'clavis-subject-1',
  email: 'ada@suite.example.com',
  issuer: SUITE_ISSUER,
  organizationId: SUITE_ORGANIZATION_ID,
};

const WORKSPACE = { id: SUITE_WORKSPACE_ID } as WorkspaceEntity;

describe('SuiteExchangeService', () => {
  let suiteExchangeService: SuiteExchangeService;
  let suiteTokenVerifierService: { verify: jest.Mock };
  let signInUpService: {
    signInUpOnExistingWorkspace: jest.Mock;
    computePartialUserFromUserPayload: jest.Mock;
  };
  let userService: { findUserByEmail: jest.Mock };
  let loginTokenService: { generateLoginToken: jest.Mock };
  let userSessionService: { resolveSession: jest.Mock };
  let onboardingService: { skipOnboardingConnectAccountStep: jest.Mock };
  let workspaceDomainsService: { buildWorkspaceURL: jest.Mock };
  let workspaceRepository: Repository<WorkspaceEntity>;
  let userRepository: Repository<UserEntity>;
  let suiteUserIdentityRepository: Repository<SuiteUserIdentityEntity>;
  let insertExecute: jest.Mock;
  let configValues: Record<string, unknown>;

  const VERIFIED_USER = {
    id: 'user-1',
    email: 'ada@suite.example.com',
    isEmailVerified: true,
  } as UserEntity;

  beforeEach(async () => {
    configValues = {
      SUITE_EXCHANGE_ENABLED: true,
      SUITE_WORKSPACE_ID,
    };

    insertExecute = jest.fn().mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuiteExchangeService,
        {
          provide: SuiteTokenVerifierService,
          useValue: { verify: jest.fn().mockResolvedValue(CLAIMS) },
        },
        {
          provide: SignInUpService,
          useValue: {
            signInUpOnExistingWorkspace: jest.fn(),
            computePartialUserFromUserPayload: jest.fn(),
          },
        },
        {
          provide: UserService,
          useValue: { findUserByEmail: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: LoginTokenService,
          useValue: {
            generateLoginToken: jest
              .fn()
              .mockResolvedValue({ token: 'login-token' }),
          },
        },
        {
          provide: UserSessionService,
          useValue: { resolveSession: jest.fn() },
        },
        {
          provide: OnboardingService,
          useValue: { skipOnboardingConnectAccountStep: jest.fn() },
        },
        {
          provide: WorkspaceDomainsService,
          useValue: {
            buildWorkspaceURL: jest.fn(({ pathname, searchParams }) => {
              const url = new URL(WORKSPACE_URL);

              if (pathname) {
                url.pathname = pathname;
              }

              Object.entries(
                (searchParams ?? {}) as Record<string, string>,
              ).forEach(([key, value]) => url.searchParams.set(key, value));

              return url;
            }),
          },
        },
        {
          provide: TwentyConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
        {
          provide: getRepositoryToken(WorkspaceEntity),
          useValue: { findOne: jest.fn().mockResolvedValue(WORKSPACE) },
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(SuiteUserIdentityEntity),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            delete: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue({
              insert: jest.fn().mockReturnThis(),
              values: jest.fn().mockReturnThis(),
              orIgnore: jest.fn().mockReturnThis(),
              execute: insertExecute,
            }),
          },
        },
      ],
    }).compile();

    suiteExchangeService =
      module.get<SuiteExchangeService>(SuiteExchangeService);
    suiteTokenVerifierService = module.get(SuiteTokenVerifierService);
    signInUpService = module.get(SignInUpService);
    userService = module.get(UserService);
    loginTokenService = module.get(LoginTokenService);
    userSessionService = module.get(UserSessionService);
    onboardingService = module.get(OnboardingService);
    workspaceDomainsService = module.get(WorkspaceDomainsService);
    workspaceRepository = module.get(getRepositoryToken(WorkspaceEntity));
    userRepository = module.get(getRepositoryToken(UserEntity));
    suiteUserIdentityRepository = module.get(
      getRepositoryToken(SuiteUserIdentityEntity),
    );
  });

  const linkIdentityTo = (user: UserEntity) => {
    jest.spyOn(suiteUserIdentityRepository, 'findOne').mockResolvedValue({
      id: 'identity-1',
      userId: user.id,
    } as SuiteUserIdentityEntity);
    jest.spyOn(userRepository, 'findOne').mockResolvedValue(user);
  };

  it('refuses to exchange when the feature is disabled', async () => {
    configValues.SUITE_EXCHANGE_ENABLED = false;

    await expect(
      suiteExchangeService.exchangeForRedirectUrl({ subjectToken: 'token' }),
    ).rejects.toThrow('Suite token exchange is disabled');
    expect(suiteTokenVerifierService.verify).not.toHaveBeenCalled();
  });

  it('refuses a next that is not a relative path', async () => {
    await expect(
      suiteExchangeService.exchangeForRedirectUrl({
        subjectToken: 'token',
        next: 'https://evil.example.com',
      }),
    ).rejects.toThrow(AuthException);
    expect(suiteTokenVerifierService.verify).not.toHaveBeenCalled();
  });

  it('fails when the configured workspace does not exist', async () => {
    jest.spyOn(workspaceRepository, 'findOne').mockResolvedValue(null);

    await expect(
      suiteExchangeService.exchangeForRedirectUrl({ subjectToken: 'token' }),
    ).rejects.toThrow('Suite workspace not found');
  });

  it('creates the user, adds them to the workspace and records the suite identity', async () => {
    signInUpService.computePartialUserFromUserPayload.mockResolvedValue({
      email: CLAIMS.email,
    });
    signInUpService.signInUpOnExistingWorkspace.mockResolvedValue(
      VERIFIED_USER,
    );

    const redirectUrl = await suiteExchangeService.exchangeForRedirectUrl({
      subjectToken: 'token',
      next: '/objects/people',
    });

    expect(
      signInUpService.computePartialUserFromUserPayload,
    ).toHaveBeenCalledWith(
      { email: CLAIMS.email, isEmailAlreadyVerified: true },
      { provider: AuthProviderEnum.SSO },
    );
    expect(signInUpService.signInUpOnExistingWorkspace).toHaveBeenCalledWith({
      workspace: WORKSPACE,
      userData: {
        type: 'newUserWithPicture',
        newUserWithPicture: { email: CLAIMS.email },
      },
    });
    expect(insertExecute).toHaveBeenCalledTimes(1);
    expect(loginTokenService.generateLoginToken).toHaveBeenCalledWith(
      VERIFIED_USER.email,
      SUITE_WORKSPACE_ID,
      AuthProviderEnum.SSO,
    );
    expect(redirectUrl).toBe(
      'https://crm.example.com/verify?loginToken=login-token&returnToPath=%2Fobjects%2Fpeople',
    );
  });

  it('skips the connect-account onboarding step for a new user', async () => {
    signInUpService.computePartialUserFromUserPayload.mockResolvedValue({
      email: CLAIMS.email,
    });
    signInUpService.signInUpOnExistingWorkspace.mockResolvedValue(
      VERIFIED_USER,
    );

    await suiteExchangeService.exchangeForRedirectUrl({
      subjectToken: 'token',
    });

    expect(
      onboardingService.skipOnboardingConnectAccountStep,
    ).toHaveBeenCalledWith({
      userId: VERIFIED_USER.id,
      workspaceId: SUITE_WORKSPACE_ID,
      isAutoSkipped: true,
    });
  });

  it('reuses a verified user that already exists under the same email', async () => {
    const existingUser = {
      id: 'user-2',
      email: 'ada@suite.example.com',
      isEmailVerified: true,
    } as UserEntity;

    userService.findUserByEmail.mockResolvedValue(existingUser);
    signInUpService.signInUpOnExistingWorkspace.mockResolvedValue(existingUser);

    await suiteExchangeService.exchangeForRedirectUrl({
      subjectToken: 'token',
    });

    expect(
      signInUpService.computePartialUserFromUserPayload,
    ).not.toHaveBeenCalled();
    expect(signInUpService.signInUpOnExistingWorkspace).toHaveBeenCalledWith({
      workspace: WORKSPACE,
      userData: { type: 'existingUser', existingUser },
    });
    expect(insertExecute).toHaveBeenCalledTimes(1);
    expect(
      onboardingService.skipOnboardingConnectAccountStep,
    ).not.toHaveBeenCalled();
  });

  it('refuses to link a suite subject to an unverified Twenty account', async () => {
    userService.findUserByEmail.mockResolvedValue({
      id: 'user-squatter',
      email: 'ada@suite.example.com',
      isEmailVerified: false,
    } as UserEntity);

    await expect(
      suiteExchangeService.exchangeForRedirectUrl({ subjectToken: 'token' }),
    ).rejects.toMatchObject({
      message: 'A Twenty account with this email exists but is not verified',
      code: AuthExceptionCode.FORBIDDEN_EXCEPTION,
    });
    expect(signInUpService.signInUpOnExistingWorkspace).not.toHaveBeenCalled();
    expect(insertExecute).not.toHaveBeenCalled();
  });

  it('follows the recorded suite identity when the suite email changed', async () => {
    const linkedUser = {
      id: 'user-3',
      email: 'ada.old@suite.example.com',
      isEmailVerified: true,
    } as UserEntity;

    linkIdentityTo(linkedUser);
    signInUpService.signInUpOnExistingWorkspace.mockResolvedValue(linkedUser);

    await suiteExchangeService.exchangeForRedirectUrl({
      subjectToken: 'token',
    });

    expect(userService.findUserByEmail).not.toHaveBeenCalled();
    expect(insertExecute).not.toHaveBeenCalled();
    // The Twenty email stays authoritative for the login token.
    expect(loginTokenService.generateLoginToken).toHaveBeenCalledWith(
      'ada.old@suite.example.com',
      SUITE_WORKSPACE_ID,
      AuthProviderEnum.SSO,
    );
  });

  it('reprovisions when the recorded identity points at a deleted user', async () => {
    jest.spyOn(suiteUserIdentityRepository, 'findOne').mockResolvedValue({
      id: 'identity-2',
      userId: 'gone',
    } as SuiteUserIdentityEntity);
    jest.spyOn(userRepository, 'findOne').mockResolvedValue(null);
    signInUpService.computePartialUserFromUserPayload.mockResolvedValue({
      email: CLAIMS.email,
    });
    signInUpService.signInUpOnExistingWorkspace.mockResolvedValue(
      VERIFIED_USER,
    );

    await suiteExchangeService.exchangeForRedirectUrl({
      subjectToken: 'token',
    });

    expect(suiteUserIdentityRepository.delete).toHaveBeenCalledWith({
      id: 'identity-2',
    });
    expect(insertExecute).toHaveBeenCalledTimes(1);
  });

  describe('when the frame already carries a session', () => {
    beforeEach(() => {
      linkIdentityTo(VERIFIED_USER);
      signInUpService.signInUpOnExistingWorkspace.mockResolvedValue(
        VERIFIED_USER,
      );
    });

    it('redirects to next without minting a second session', async () => {
      userSessionService.resolveSession.mockResolvedValue({
        payload: {
          type: JwtTokenTypeEnum.ACCESS,
          userId: VERIFIED_USER.id,
          workspaceId: SUITE_WORKSPACE_ID,
        },
      });

      const redirectUrl = await suiteExchangeService.exchangeForRedirectUrl({
        subjectToken: 'token',
        next: '/objects/people?view=abc',
        presentedSessionToken: 'session-token',
      });

      expect(redirectUrl).toBe(
        'https://crm.example.com/objects/people?view=abc',
      );
      expect(loginTokenService.generateLoginToken).not.toHaveBeenCalled();
      expect(
        signInUpService.signInUpOnExistingWorkspace,
      ).not.toHaveBeenCalled();
    });

    it('records the suite identity for a user matched on email alone', async () => {
      jest
        .spyOn(suiteUserIdentityRepository, 'findOne')
        .mockResolvedValue(null);
      userService.findUserByEmail.mockResolvedValue(VERIFIED_USER);
      userSessionService.resolveSession.mockResolvedValue({
        payload: {
          type: JwtTokenTypeEnum.ACCESS,
          userId: VERIFIED_USER.id,
          workspaceId: SUITE_WORKSPACE_ID,
        },
      });

      await suiteExchangeService.exchangeForRedirectUrl({
        subjectToken: 'token',
        presentedSessionToken: 'session-token',
      });

      expect(insertExecute).toHaveBeenCalledTimes(1);
      expect(loginTokenService.generateLoginToken).not.toHaveBeenCalled();
    });

    it('does not record the suite identity again for an already linked user', async () => {
      userSessionService.resolveSession.mockResolvedValue({
        payload: {
          type: JwtTokenTypeEnum.ACCESS,
          userId: VERIFIED_USER.id,
          workspaceId: SUITE_WORKSPACE_ID,
        },
      });

      await suiteExchangeService.exchangeForRedirectUrl({
        subjectToken: 'token',
        presentedSessionToken: 'session-token',
      });

      expect(insertExecute).not.toHaveBeenCalled();
    });

    it('lands on the workspace root when no next is given', async () => {
      userSessionService.resolveSession.mockResolvedValue({
        payload: {
          type: JwtTokenTypeEnum.ACCESS,
          userId: VERIFIED_USER.id,
          workspaceId: SUITE_WORKSPACE_ID,
        },
      });

      expect(
        await suiteExchangeService.exchangeForRedirectUrl({
          subjectToken: 'token',
          presentedSessionToken: 'session-token',
        }),
      ).toBe(WORKSPACE_URL);
      expect(workspaceDomainsService.buildWorkspaceURL).toHaveBeenCalledWith({
        workspace: WORKSPACE,
      });
    });

    it('mints when the session belongs to another user', async () => {
      userSessionService.resolveSession.mockResolvedValue({
        payload: {
          type: JwtTokenTypeEnum.ACCESS,
          userId: 'someone-else',
          workspaceId: SUITE_WORKSPACE_ID,
        },
      });

      await suiteExchangeService.exchangeForRedirectUrl({
        subjectToken: 'token',
        presentedSessionToken: 'session-token',
      });

      expect(loginTokenService.generateLoginToken).toHaveBeenCalledTimes(1);
    });

    it('mints when the session belongs to another workspace', async () => {
      userSessionService.resolveSession.mockResolvedValue({
        payload: {
          type: JwtTokenTypeEnum.ACCESS,
          userId: VERIFIED_USER.id,
          workspaceId: 'another-workspace',
        },
      });

      await suiteExchangeService.exchangeForRedirectUrl({
        subjectToken: 'token',
        presentedSessionToken: 'session-token',
      });

      expect(loginTokenService.generateLoginToken).toHaveBeenCalledTimes(1);
    });

    it('mints when the presented session has expired', async () => {
      userSessionService.resolveSession.mockRejectedValue(
        new AuthException('Invalid session', AuthExceptionCode.UNAUTHENTICATED),
      );

      await suiteExchangeService.exchangeForRedirectUrl({
        subjectToken: 'token',
        presentedSessionToken: 'session-token',
      });

      expect(loginTokenService.generateLoginToken).toHaveBeenCalledTimes(1);
    });

    it('mints for a first exchange, when no user is linked yet', async () => {
      jest
        .spyOn(suiteUserIdentityRepository, 'findOne')
        .mockResolvedValue(null);
      signInUpService.computePartialUserFromUserPayload.mockResolvedValue({
        email: CLAIMS.email,
      });

      await suiteExchangeService.exchangeForRedirectUrl({
        subjectToken: 'token',
        presentedSessionToken: 'session-token',
      });

      expect(userSessionService.resolveSession).not.toHaveBeenCalled();
      expect(loginTokenService.generateLoginToken).toHaveBeenCalledTimes(1);
    });
  });
});
