import { Inject, Injectable } from '@nestjs/common';

import { isNonEmptyString } from '@sniptt/guards';
import { type JWTVerifyGetKey, jwtVerify } from 'jose';
import { isDefined } from 'twenty-shared/utils';

import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import {
  SUITE_JWKS_RESOLVER,
  type SuiteJwksResolver,
} from 'src/engine/core-modules/auth/suite-exchange/constants/suite-jwks-resolver.constants';
import { type SuiteTokenClaims } from 'src/engine/core-modules/auth/suite-exchange/types/suite-token-claims.type';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

// Clavis signs with EdDSA (Ed25519), which Twenty's jsonwebtoken-based
// JwtWrapperService cannot verify (HS256/ES256 only) — hence jose here.
@Injectable()
export class SuiteTokenVerifierService {
  private cachedKeySet:
    | { jwksUrl: string; keySet: JWTVerifyGetKey }
    | undefined;

  constructor(
    private readonly twentyConfigService: TwentyConfigService,
    @Inject(SUITE_JWKS_RESOLVER)
    private readonly suiteJwksResolver: SuiteJwksResolver,
  ) {}

  async verify(subjectToken: string): Promise<SuiteTokenClaims> {
    const issuer = this.twentyConfigService.get('SUITE_ISSUER');
    const audience = this.twentyConfigService.get('SUITE_AUDIENCE');

    const payload = await this.verifyOrThrow(subjectToken, issuer, audience);

    const subject = payload.sub;
    const email = payload.email;
    const organizationId = payload.org_id;

    if (!isNonEmptyString(subject)) {
      throw new AuthException(
        'Suite token is missing a subject',
        AuthExceptionCode.FORBIDDEN_EXCEPTION,
      );
    }

    if (!isNonEmptyString(email)) {
      throw new AuthException(
        'Suite token is missing an email claim',
        AuthExceptionCode.FORBIDDEN_EXCEPTION,
      );
    }

    this.assertOrganizationIsAllowed(organizationId);

    return {
      subject,
      email: email.toLowerCase(),
      issuer,
      ...(isNonEmptyString(organizationId) ? { organizationId } : {}),
    };
  }

  // A deployment serves one workspace, so without this pin every organisation
  // of the issuer would share it — and each other's records.
  private assertOrganizationIsAllowed(organizationId: unknown): void {
    const allowedOrganizationId = this.twentyConfigService.get('SUITE_ORG_ID');

    if (!isNonEmptyString(allowedOrganizationId)) {
      return;
    }

    if (organizationId !== allowedOrganizationId) {
      throw new AuthException(
        'Suite token belongs to another organisation',
        AuthExceptionCode.FORBIDDEN_EXCEPTION,
      );
    }
  }

  private async verifyOrThrow(
    subjectToken: string,
    issuer: string,
    audience: string,
  ) {
    try {
      const { payload } = await jwtVerify<{
        email?: string;
        org_id?: string;
      }>(subjectToken, this.getKeySet(), {
        issuer,
        audience,
        algorithms: ['EdDSA'],
      });

      return payload;
    } catch {
      // The reason is deliberately not echoed back: the caller is an untrusted
      // cross-origin page and every failure means the same thing to it.
      throw new AuthException(
        'Suite token verification failed',
        AuthExceptionCode.FORBIDDEN_EXCEPTION,
      );
    }
  }

  // jose keeps its own key cache behind this handle and refetches when it meets
  // an unknown kid, so it is built once per JWKS URL rather than per request.
  private getKeySet(): JWTVerifyGetKey {
    const jwksUrl = this.twentyConfigService.get('SUITE_JWKS_URL');

    if (isDefined(this.cachedKeySet) && this.cachedKeySet.jwksUrl === jwksUrl) {
      return this.cachedKeySet.keySet;
    }

    const keySet = this.suiteJwksResolver(jwksUrl);

    this.cachedKeySet = { jwksUrl, keySet };

    return keySet;
  }
}
