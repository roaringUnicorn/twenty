import request from 'supertest';

import { USER_SESSION_COOKIE_NAME } from 'src/engine/core-modules/user-session/constants/user-session-cookie-name.constant';

const client = request(`http://localhost:${APP_PORT}`);

const SUITE_EXCHANGE_PATH = '/auth/suite/exchange';

// Covers the wiring the unit tests cannot reach: the urlencoded body parser,
// the CSRF exclusion and the exception filter. SUITE_EXCHANGE_ENABLED is off in
// the test environment, so no token is actually exchanged.
describe('Suite token exchange endpoint (integration)', () => {
  it('should answer a cross-origin cookie-bearing form post with the error redirect instead of the CSRF refusal', async () => {
    const response = await client
      .post(SUITE_EXCHANGE_PATH)
      // A session cookie plus a foreign Origin is exactly what
      // CookieSessionCsrfMiddleware answers with 403 CSRF_ORIGIN_MISMATCH on
      // every route it is not excluded from.
      .set('Origin', 'https://evil.example')
      .set('Cookie', `${USER_SESSION_COOKIE_NAME}=not-a-real-session-token`)
      .type('form')
      .send({ subject_token: 'not-a-real-token' });

    expect(response.status).toBe(302);
    expect(response.body.error).not.toBe('CSRF_ORIGIN_MISMATCH');

    const location = response.headers.location;

    expect(location).toContain('/verify');
    expect(location).toContain('errorMessage=');
  });

  it('should answer a body without a subject token with the INVALID_INPUT mapping rather than a redirect', async () => {
    const response = await client.post(SUITE_EXCHANGE_PATH).type('form').send();

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.body.messages[0]).toBe('subject_token is required');
  });
});
