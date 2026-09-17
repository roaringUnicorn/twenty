import { isSafeSuiteNextPath } from 'src/engine/core-modules/auth/suite-exchange/utils/is-safe-suite-next-path.util';

describe('isSafeSuiteNextPath', () => {
  it.each([
    ['/', true],
    ['/objects/people', true],
    ['/objects/people?view=abc#top', true],
    ['', false],
    ['objects/people', false],
    ['//evil.example.com', false],
    ['https://evil.example.com', false],
    ['/\\evil.example.com', false],
    ['/objects\nLocation: https://evil.example.com', false],
  ])('returns %s for %p', (path, expected) => {
    expect(isSafeSuiteNextPath(path)).toBe(expected);
  });
});
