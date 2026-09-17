import { isNonEmptyString } from '@sniptt/guards';

// Mirrors twenty-front's isSafeInternalPath: the exchange is reached from a
// cross-origin page, so `next` is attacker-reachable and must never be able to
// express another origin (`//evil.host`, `\evil.host`) or smuggle control
// characters into the redirect header.
export const isSafeSuiteNextPath = (path: string): boolean =>
  isNonEmptyString(path) &&
  path.startsWith('/') &&
  !path.startsWith('//') &&
  !path.includes('\\') &&
  !/[\u0000-\u001f\u007f]/u.test(path);
