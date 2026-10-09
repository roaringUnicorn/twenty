import { isNonEmptyString } from '@sniptt/guards';
import { isDefined } from 'twenty-shared/utils';

// Opaque origins (sandboxed frames, some redirects) serialize to the string
// `null`, which must never match a configured origin that also failed to parse.
const parseOrigin = (value: string): string | undefined => {
  try {
    const { origin } = new URL(value);

    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
};

// Compared as origins rather than as strings, so a configured value carrying a
// trailing slash or a default port still matches the header the browser sends.
export const isSuiteHostOrigin = ({
  origin,
  allowedOrigin,
}: {
  origin?: string;
  allowedOrigin?: string;
}): boolean => {
  if (!isNonEmptyString(origin) || !isNonEmptyString(allowedOrigin)) {
    return false;
  }

  const parsedOrigin = parseOrigin(origin);
  const parsedAllowedOrigin = parseOrigin(allowedOrigin);

  return (
    isDefined(parsedOrigin) &&
    isDefined(parsedAllowedOrigin) &&
    parsedOrigin === parsedAllowedOrigin
  );
};
