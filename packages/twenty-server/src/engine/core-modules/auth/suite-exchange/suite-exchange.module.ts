import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { createRemoteJWKSet } from 'jose';

import { AuthModule } from 'src/engine/core-modules/auth/auth.module';
import { SUITE_JWKS_RESOLVER } from 'src/engine/core-modules/auth/suite-exchange/constants/suite-jwks-resolver.constants';
import { SuiteUserIdentityEntity } from 'src/engine/core-modules/auth/suite-exchange/entities/suite-user-identity.entity';
import { SuiteExchangeService } from 'src/engine/core-modules/auth/suite-exchange/services/suite-exchange.service';
import { SuiteTokenVerifierService } from 'src/engine/core-modules/auth/suite-exchange/services/suite-token-verifier.service';
import { SuiteExchangeController } from 'src/engine/core-modules/auth/suite-exchange/suite-exchange.controller';
import { WorkspaceDomainsModule } from 'src/engine/core-modules/domain/workspace-domains/workspace-domains.module';
import { GuardRedirectModule } from 'src/engine/core-modules/guard-redirect/guard-redirect.module';
import { OnboardingModule } from 'src/engine/core-modules/onboarding/onboarding.module';
import { ThrottlerModule } from 'src/engine/core-modules/throttler/throttler.module';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { UserModule } from 'src/engine/core-modules/user/user.module';
import { UserSessionModule } from 'src/engine/core-modules/user-session/user-session.module';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

@Module({
  imports: [
    AuthModule,
    UserModule,
    UserSessionModule,
    OnboardingModule,
    WorkspaceDomainsModule,
    GuardRedirectModule,
    ThrottlerModule,
    TypeOrmModule.forFeature([
      SuiteUserIdentityEntity,
      UserEntity,
      WorkspaceEntity,
    ]),
  ],
  controllers: [SuiteExchangeController],
  providers: [
    SuiteExchangeService,
    SuiteTokenVerifierService,
    {
      provide: SUITE_JWKS_RESOLVER,
      useValue: (jwksUrl: string) => createRemoteJWKSet(new URL(jwksUrl)),
    },
  ],
})
export class SuiteExchangeModule {}
