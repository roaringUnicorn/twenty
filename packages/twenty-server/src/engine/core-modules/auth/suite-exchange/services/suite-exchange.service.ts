import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isNonEmptyString } from '@sniptt/guards';
import { AppPath } from 'twenty-shared/types';
import { isDefined, isSafeInternalPath } from 'twenty-shared/utils';
import { Repository } from 'typeorm';

import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { SignInUpService } from 'src/engine/core-modules/auth/services/sign-in-up.service';
import { SuiteUserIdentityEntity } from 'src/engine/core-modules/auth/suite-exchange/entities/suite-user-identity.entity';
import { SuiteTokenVerifierService } from 'src/engine/core-modules/auth/suite-exchange/services/suite-token-verifier.service';
import { type SuiteTokenClaims } from 'src/engine/core-modules/auth/suite-exchange/types/suite-token-claims.type';
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

type ResolvedSuiteUser = {
  user: UserEntity;
  isAlreadyLinked: boolean;
};

@Injectable()
export class SuiteExchangeService {
  private readonly logger = new Logger(SuiteExchangeService.name);

  constructor(
    private readonly suiteTokenVerifierService: SuiteTokenVerifierService,
    private readonly signInUpService: SignInUpService,
    private readonly userService: UserService,
    private readonly loginTokenService: LoginTokenService,
    private readonly userSessionService: UserSessionService,
    private readonly onboardingService: OnboardingService,
    private readonly workspaceDomainsService: WorkspaceDomainsService,
    private readonly twentyConfigService: TwentyConfigService,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    // Instance-level identity mapping: it links a suite subject to a core user
    // and has no workspaceId to scope on.
    // eslint-disable-next-line twenty/prefer-workspace-scoped-repository
    @InjectRepository(SuiteUserIdentityEntity)
    private readonly suiteUserIdentityRepository: Repository<SuiteUserIdentityEntity>,
  ) {}

  isEnabled(): boolean {
    return this.twentyConfigService.get('SUITE_EXCHANGE_ENABLED') === true;
  }

  async exchangeForRedirectUrl({
    subjectToken,
    next,
    presentedSessionToken,
  }: {
    subjectToken: string;
    next?: string;
    presentedSessionToken?: string;
  }): Promise<string> {
    if (!this.isEnabled()) {
      throw new AuthException(
        'Suite token exchange is disabled',
        AuthExceptionCode.FORBIDDEN_EXCEPTION,
      );
    }

    // The exchange is reached from a cross-origin page, so `next` is
    // attacker-reachable and must never be able to express another origin
    // (`//evil.host`, `\evil.host`) or smuggle control characters into the
    // redirect header.
    if (isDefined(next) && !isSafeInternalPath(next)) {
      throw new AuthException(
        'next must be a relative path within this instance',
        AuthExceptionCode.INVALID_INPUT,
      );
    }

    const claims = await this.suiteTokenVerifierService.verify(subjectToken);

    const workspace = await this.findWorkspaceOrThrow();

    const resolvedUser = await this.resolveExistingUser(claims);

    if (
      isDefined(resolvedUser) &&
      isDefined(presentedSessionToken) &&
      (await this.isSessionMatchingExchange({
        sessionToken: presentedSessionToken,
        user: resolvedUser.user,
        workspace,
      }))
    ) {
      // The user was matched on email only, and this path never reaches
      // provisionUser, so the identity row would otherwise wait for an exchange
      // that presents no session.
      if (!resolvedUser.isAlreadyLinked) {
        await this.linkSuiteIdentity(claims, resolvedUser.user.id);
      }

      // Minting here would revoke the session the frame still holds as
      // SUPERSEDED, and the frame — which boots believing it is signed in —
      // would fire queries with the dead cookie and be bounced to sign-in.
      return this.buildNextUrl(workspace, next);
    }

    const user = await this.provisionUser(claims, workspace, resolvedUser);

    const { token } = await this.loginTokenService.generateLoginToken(
      user.email,
      workspace.id,
      AuthProviderEnum.SSO,
    );

    // Mirrors AuthService.computeRedirectURI, called directly so this module
    // does not need AuthService exported from AuthModule.
    return this.workspaceDomainsService
      .buildWorkspaceURL({
        workspace,
        pathname: AppPath.Verify,
        searchParams: {
          loginToken: token,
          ...(isNonEmptyString(next) && next.startsWith('/')
            ? { returnToPath: next }
            : {}),
        },
      })
      .toString();
  }

  // `next` can carry a query string and a fragment, which the URL pathname
  // setter would percent-encode, so it is resolved against the origin instead.
  private buildNextUrl(workspace: WorkspaceEntity, next?: string): string {
    const workspaceUrl = this.workspaceDomainsService.buildWorkspaceURL({
      workspace,
    });

    return new URL(next ?? '/', workspaceUrl).toString();
  }

  private async isSessionMatchingExchange({
    sessionToken,
    user,
    workspace,
  }: {
    sessionToken: string;
    user: UserEntity;
    workspace: WorkspaceEntity;
  }): Promise<boolean> {
    try {
      const { payload } =
        await this.userSessionService.resolveSession(sessionToken);

      return (
        payload.type === JwtTokenTypeEnum.ACCESS &&
        payload.userId === user.id &&
        payload.workspaceId === workspace.id
      );
    } catch (error) {
      if (
        error instanceof AuthException &&
        error.code === AuthExceptionCode.UNAUTHENTICATED
      ) {
        return false;
      }

      throw error;
    }
  }

  private async findWorkspaceOrThrow(): Promise<WorkspaceEntity> {
    const workspaceId = this.twentyConfigService.get('SUITE_WORKSPACE_ID');

    const workspace = await this.workspaceRepository.findOne({
      where: { id: workspaceId },
    });

    if (!isDefined(workspace)) {
      throw new AuthException(
        'Suite workspace not found',
        AuthExceptionCode.WORKSPACE_NOT_FOUND,
      );
    }

    return workspace;
  }

  // The Twenty user this assertion already maps to, if any. It does not
  // provision or link, so the caller can still decide between reusing a live
  // session and provisioning; it does drop a dangling identity row on the way.
  private async resolveExistingUser(
    claims: SuiteTokenClaims,
  ): Promise<ResolvedSuiteUser | undefined> {
    const linkedUser = await this.findUserBySuiteIdentity(claims);

    if (isDefined(linkedUser)) {
      return { user: linkedUser, isAlreadyLinked: true };
    }

    const existingUser = await this.userService.findUserByEmail(claims.email);

    if (!isDefined(existingUser)) {
      return undefined;
    }

    // An unverified Twenty account under this email proves nothing about who
    // created it: with password sign-up on, anybody can register a victim's
    // address and would keep password access to the account the exchange then
    // hands them.
    if (existingUser.isEmailVerified !== true) {
      throw new AuthException(
        'A Twenty account with this email exists but is not verified',
        AuthExceptionCode.FORBIDDEN_EXCEPTION,
      );
    }

    return { user: existingUser, isAlreadyLinked: false };
  }

  // The verified suite assertion is the authorization: SUITE_WORKSPACE_ID is the
  // one workspace this deployment serves, so membership is granted here rather
  // than gated on an invitation the way AuthService.checkAccessForSignIn does
  // for a workspace-level identity provider.
  private async provisionUser(
    claims: SuiteTokenClaims,
    workspace: WorkspaceEntity,
    resolvedUser: ResolvedSuiteUser | undefined,
  ): Promise<UserEntity> {
    if (isDefined(resolvedUser)) {
      const user = await this.signInUpService.signInUpOnExistingWorkspace({
        workspace,
        userData: { type: 'existingUser', existingUser: resolvedUser.user },
      });

      if (!resolvedUser.isAlreadyLinked) {
        await this.linkSuiteIdentity(claims, user.id);
      }

      return user;
    }

    const user = await this.signInUpService.signInUpOnExistingWorkspace({
      workspace,
      userData: {
        type: 'newUserWithPicture',
        newUserWithPicture:
          await this.signInUpService.computePartialUserFromUserPayload(
            {
              email: claims.email,
              isEmailAlreadyVerified: true,
            },
            { provider: AuthProviderEnum.SSO },
          ),
      },
    });

    await this.linkSuiteIdentity(claims, user.id);

    await this.skipConnectAccountOnboardingStep(user, workspace);

    return user;
  }

  // signInUpOnExistingWorkspace opens the connect-account step for every new
  // user, and a suite user has no mailbox in Twenty to connect — it would only
  // stand between them and the records they came for.
  private async skipConnectAccountOnboardingStep(
    user: UserEntity,
    workspace: WorkspaceEntity,
  ): Promise<void> {
    await this.onboardingService.skipOnboardingConnectAccountStep({
      userId: user.id,
      workspaceId: workspace.id,
      isAutoSkipped: true,
    });
  }

  private async findUserBySuiteIdentity(
    claims: SuiteTokenClaims,
  ): Promise<UserEntity | undefined> {
    const identity = await this.suiteUserIdentityRepository.findOne({
      where: { issuer: claims.issuer, subject: claims.subject },
    });

    if (!isDefined(identity)) {
      return undefined;
    }

    const user = await this.userRepository.findOne({
      where: { id: identity.userId },
    });

    if (!isDefined(user)) {
      // The user row is gone but the FK cascade has not run yet (or the row was
      // deleted outside TypeORM): fall back to provisioning from the email.
      this.logger.warn(
        `Suite identity ${identity.id} points at a missing user, reprovisioning`,
      );

      await this.suiteUserIdentityRepository.delete({ id: identity.id });

      return undefined;
    }

    // The Twenty email is intentionally left as-is when the suite email changed:
    // it is the subject of the login token and the key other Twenty flows use.
    if (isNonEmptyString(user.email) && user.email !== claims.email) {
      this.logger.log(
        `Suite subject ${claims.subject} now presents a different email; keeping the Twenty user's own email`,
      );
    }

    return user;
  }

  private async linkSuiteIdentity(
    claims: SuiteTokenClaims,
    userId: string,
  ): Promise<void> {
    // Two tabs can exchange at once; the unique (issuer, subject) index makes the
    // loser a no-op instead of a 500.
    await this.suiteUserIdentityRepository
      .createQueryBuilder()
      .insert()
      .values({ issuer: claims.issuer, subject: claims.subject, userId })
      .orIgnore()
      .execute();
  }
}
