import { isSafeInternalPath } from '../isSafeInternalPath';

describe('isSafeInternalPath', () => {
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
    expect(isSafeInternalPath(path)).toBe(expected);
  });
});
