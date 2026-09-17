import { type JWTVerifyGetKey } from 'jose';

// Injection token for the JWKS resolver, so tests can swap the remote key set
// for a local one instead of intercepting the network.
export const SUITE_JWKS_RESOLVER = 'SUITE_JWKS_RESOLVER';

export type SuiteJwksResolver = (jwksUrl: string) => JWTVerifyGetKey;
