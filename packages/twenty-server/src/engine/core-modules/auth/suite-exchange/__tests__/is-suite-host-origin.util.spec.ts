import { isSuiteHostOrigin } from 'src/engine/core-modules/auth/suite-exchange/utils/is-suite-host-origin.util';

const SUITE_HOST_ORIGIN = 'https://suite.example.com';

describe('isSuiteHostOrigin', () => {
  it.each([
    [SUITE_HOST_ORIGIN, SUITE_HOST_ORIGIN, true],
    [SUITE_HOST_ORIGIN, 'https://suite.example.com/', true],
    [SUITE_HOST_ORIGIN, 'https://suite.example.com:443', true],
    ['http://localhost:3000', 'http://localhost:3000/suite', true],
    [SUITE_HOST_ORIGIN, 'http://suite.example.com', false],
    [SUITE_HOST_ORIGIN, 'https://suite.example.com:8443', false],
    ['https://evil.example.com', SUITE_HOST_ORIGIN, false],
    ['https://suite.example.com.evil.test', SUITE_HOST_ORIGIN, false],
    ['null', SUITE_HOST_ORIGIN, false],
    ['not an origin', SUITE_HOST_ORIGIN, false],
    ['', SUITE_HOST_ORIGIN, false],
    [undefined, SUITE_HOST_ORIGIN, false],
    [SUITE_HOST_ORIGIN, undefined, false],
    [SUITE_HOST_ORIGIN, '', false],
    ['null', 'null', false],
  ])('origin %p against %p is %p', (origin, allowedOrigin, expected) => {
    expect(isSuiteHostOrigin({ origin, allowedOrigin })).toBe(expected);
  });
});
