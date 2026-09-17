import { Test, type TestingModule } from '@nestjs/testing';

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from 'jose';

import { AuthException } from 'src/engine/core-modules/auth/auth.exception';
import { SUITE_JWKS_RESOLVER } from 'src/engine/core-modules/auth/suite-exchange/constants/suite-jwks-resolver.constants';
import { SuiteTokenVerifierService } from 'src/engine/core-modules/auth/suite-exchange/services/suite-token-verifier.service';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

const SUITE_ISSUER = 'https://suite.example.com';
const SUITE_AUDIENCE = 'ovh-suite';
const SUITE_JWKS_URL = 'http://clavis:3001/api/clavis/.well-known/jwks.json';
const KEY_ID = 'clavis-key-1';
const SUITE_ORG_ID = '20202020-1c25-4d02-bf25-6aeccf7ea419';

describe('SuiteTokenVerifierService', () => {
  let suiteTokenVerifierService: SuiteTokenVerifierService;
  let privateKey: CryptoKey;
  let publicJwk: JWK;
  let suiteJwksResolver: jest.Mock;
  let configValues: Record<string, unknown>;

  const signToken = async ({
    claims = {},
    issuer = SUITE_ISSUER,
    audience = SUITE_AUDIENCE,
    expirationTime = '5m',
  }: {
    claims?: Record<string, unknown>;
    issuer?: string;
    audience?: string;
    expirationTime?: string | number;
  } = {}) =>
    await new SignJWT({ email: 'ada@suite.example.com', ...claims })
      .setProtectedHeader({ alg: 'EdDSA', kid: KEY_ID })
      .setSubject('019e5fe2-34b7-7882-ba36-0fb0ae25f6f5')
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expirationTime)
      .sign(privateKey);

  beforeAll(async () => {
    const keyPair = await generateKeyPair('EdDSA', {
      crv: 'Ed25519',
      extractable: true,
    });

    privateKey = keyPair.privateKey;
    publicJwk = {
      ...(await exportJWK(keyPair.publicKey)),
      alg: 'EdDSA',
      kid: KEY_ID,
      use: 'sig',
    };
  });

  beforeEach(async () => {
    suiteJwksResolver = jest
      .fn()
      .mockReturnValue(createLocalJWKSet({ keys: [publicJwk] }));

    configValues = {
      SUITE_ISSUER,
      SUITE_AUDIENCE,
      SUITE_JWKS_URL,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuiteTokenVerifierService,
        {
          provide: TwentyConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
        { provide: SUITE_JWKS_RESOLVER, useValue: suiteJwksResolver },
      ],
    }).compile();

    suiteTokenVerifierService = module.get<SuiteTokenVerifierService>(
      SuiteTokenVerifierService,
    );
  });

  it('returns the claims of a valid token', async () => {
    const claims = await suiteTokenVerifierService.verify(await signToken());

    expect(claims).toEqual({
      subject: '019e5fe2-34b7-7882-ba36-0fb0ae25f6f5',
      email: 'ada@suite.example.com',
      issuer: SUITE_ISSUER,
    });
  });

  it('lowercases the email claim', async () => {
    const claims = await suiteTokenVerifierService.verify(
      await signToken({ claims: { email: 'Ada@Suite.Example.com' } }),
    );

    expect(claims.email).toBe('ada@suite.example.com');
  });

  it('builds the key set once and reuses it', async () => {
    await suiteTokenVerifierService.verify(await signToken());
    await suiteTokenVerifierService.verify(await signToken());

    expect(suiteJwksResolver).toHaveBeenCalledTimes(1);
    expect(suiteJwksResolver).toHaveBeenCalledWith(SUITE_JWKS_URL);
  });

  it('rejects a token from another issuer', async () => {
    await expect(
      suiteTokenVerifierService.verify(
        await signToken({ issuer: 'https://evil.example.com' }),
      ),
    ).rejects.toThrow(AuthException);
  });

  it('rejects a token for another audience', async () => {
    await expect(
      suiteTokenVerifierService.verify(
        await signToken({ audience: 'another-app' }),
      ),
    ).rejects.toThrow(AuthException);
  });

  it('rejects an expired token', async () => {
    await expect(
      suiteTokenVerifierService.verify(
        await signToken({ expirationTime: '-1m' }),
      ),
    ).rejects.toThrow(AuthException);
  });

  it('rejects a token signed by an unknown key', async () => {
    const otherKeyPair = await generateKeyPair('EdDSA', {
      crv: 'Ed25519',
      extractable: true,
    });

    const foreignToken = await new SignJWT({ email: 'ada@suite.example.com' })
      .setProtectedHeader({ alg: 'EdDSA', kid: KEY_ID })
      .setSubject('019e5fe2-34b7-7882-ba36-0fb0ae25f6f5')
      .setIssuer(SUITE_ISSUER)
      .setAudience(SUITE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(otherKeyPair.privateKey);

    await expect(
      suiteTokenVerifierService.verify(foreignToken),
    ).rejects.toThrow(AuthException);
  });

  it('rejects a token without an email claim', async () => {
    await expect(
      suiteTokenVerifierService.verify(
        await signToken({ claims: { email: undefined } }),
      ),
    ).rejects.toThrow('Suite token is missing an email claim');
  });

  it('returns the organisation claim when the token carries one', async () => {
    const claims = await suiteTokenVerifierService.verify(
      await signToken({ claims: { org_id: SUITE_ORG_ID } }),
    );

    expect(claims.organizationId).toBe(SUITE_ORG_ID);
  });

  describe('when an organisation is pinned', () => {
    beforeEach(() => {
      configValues.SUITE_ORG_ID = SUITE_ORG_ID;
    });

    it('accepts a token from that organisation', async () => {
      const claims = await suiteTokenVerifierService.verify(
        await signToken({ claims: { org_id: SUITE_ORG_ID } }),
      );

      expect(claims.organizationId).toBe(SUITE_ORG_ID);
    });

    it('rejects a token from another organisation', async () => {
      await expect(
        suiteTokenVerifierService.verify(
          await signToken({
            claims: { org_id: '30303030-1c25-4d02-bf25-6aeccf7ea419' },
          }),
        ),
      ).rejects.toThrow('Suite token belongs to another organisation');
    });

    it('rejects a token with no organisation claim', async () => {
      await expect(
        suiteTokenVerifierService.verify(await signToken()),
      ).rejects.toThrow('Suite token belongs to another organisation');
    });
  });
});
