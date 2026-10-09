# Suite token exchange

Trades an OVH Suite (Clavis) access token for a Twenty session in one fixed
workspace, so a suite user who opens the embedded CRM lands signed in without
ever seeing a Twenty login screen.

This is an RFC 8693-shaped endpoint, not a full implementation: the only
`subject_token` it accepts is a Clavis access token, and the only thing it
returns is a redirect that completes Twenty's own login-token flow.

## Endpoint

```
POST /auth/suite/exchange
Content-Type: application/x-www-form-urlencoded
```

| Field           | Required | Description                                                                 |
| --------------- | -------- | --------------------------------------------------------------------------- |
| `subject_token` | yes      | The suite access token (EdDSA JWT issued by Clavis).                          |
| `next`          | no       | Twenty path to land on after sign-in. Must be a relative same-origin path.    |

On success the response is `302` to
`<workspace url>/verify?loginToken=…[&returnToPath=<next>]`. The front's
`VerifyLoginTokenEffect` redeems the login token and `useInitializeQueryParamState`
picks up `returnToPath`, which is why `next` is forwarded under Twenty's own
parameter name rather than as `next`.

When the request already carries a session cookie for the exchanged user in
this workspace, the response is instead a `302` straight to `next` (or `/`)
with no login token — see [Reusing a live session](#reusing-a-live-session).

Every failure after the body is parsed — feature disabled, token rejected,
unsafe `next`, missing workspace, unverified email collision, rate limit — is
also a `302`, to `/verify?errorMessage=…`, the same error page Twenty's SSO
callback redirects to. The response is rendered by an iframe, so an error body
would replace the CRM with JSON the user cannot act on. A request with no
`subject_token` at all is the exception and answers `400`: the host page did
not post a token, so there is no user-facing path to send anywhere.

## Usage from the host page

The suite frames Twenty on another origin, so the exchange is driven by a hidden
form post targeting the iframe — the token travels in the request body, never in
a URL, and the redirect lands the session cookie inside the frame.

```html
<iframe name="twenty-crm" src="about:blank"></iframe>

<form
  method="POST"
  action="https://crm.example.com/auth/suite/exchange"
  target="twenty-crm"
  hidden
>
  <input type="hidden" name="subject_token" value="<suite access token>" />
  <input type="hidden" name="next" value="/objects/people" />
</form>
```

The page holding this form must be served from `SUITE_HOST_ORIGIN`: the endpoint
refuses a post whose `Origin` header is anything else.

Re-run the exchange on every open: the login token is short-lived and the suite
refreshes its own access token independently.

## Configuration

| Variable                | Default     | Description                                                                                                |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `SUITE_EXCHANGE_ENABLED`| `false`     | Enables the endpoint. Everything below is required when this is true.                                        |
| `SUITE_HOST_ORIGIN`     | —           | Origin of the suite host page allowed to post the exchange, e.g. `https://suite.example.com`.                 |
| `SUITE_ISSUER`          | —           | Expected `iss` claim — the browser-facing Clavis URL.                                                         |
| `SUITE_JWKS_URL`        | —           | Where the server fetches the JWKS, e.g. `http://clavis:3001/api/clavis/.well-known/jwks.json`.                |
| `SUITE_AUDIENCE`        | `ovh-suite` | Expected `aud` claim.                                                                                        |
| `SUITE_WORKSPACE_ID`    | —           | Workspace every exchanged user lands in.                                                                     |
| `SUITE_ORG_IDS`         | —           | Comma-separated suite organisation ids allowed to exchange, matched against the token's `org_id` claim.       |

`SUITE_ISSUER` and `SUITE_JWKS_URL` are two settings on purpose: the issuer
string is the URL browsers use, which typically does not resolve from inside the
server's network.

The group is hidden from the admin panel: an admin who can repoint
`SUITE_JWKS_URL` at a key set they control can mint a session for any email.

### Cookies and framing

The exchange runs inside an iframe on the suite origin, and Twenty's session
cookie is `SameSite=Lax` by default (`AUTH_COOKIE_SAME_SITE`). A `Lax` cookie is
not sent from a cross-site frame, so the frame is signed out again right after
`/verify` and the exchange never sees the session cookie that
[Reusing a live session](#reusing-a-live-session) depends on. Either deploy the
CRM on the same registrable domain as the suite host, or set
`AUTH_COOKIE_SAME_SITE=none`, which the variable already documents as requiring
HTTPS.

The front must also be embeddable by the suite origin. `frame-ancestors` and
`X-Frame-Options` are set by whatever serves the front, not by this module.

## Verification

Tokens are verified with `jose`, not Twenty's `JwtWrapperService`: Clavis signs
with EdDSA (Ed25519) and the `jsonwebtoken`-based wrapper only does HS256/ES256.
`iss`, `aud`, `exp` and the algorithm are all pinned, and a token without an
`email` claim is rejected. The remote key set handle is built once per JWKS URL —
`jose` caches the keys behind it and refetches when it meets an unknown `kid`.

`SUITE_ORG_IDS` is the allow list of suite organisations: a token whose `org_id`
is absent, or is not one of the listed ids, is refused. The list is required and
must not be empty when the exchange is enabled, so the exchange refuses to start
rather than let every organisation of the issuer share the one workspace, and
each other's records. Sharing a CRM between organisations stays possible, but
only by listing several ids explicitly.

## Provisioning

A verified assertion is the authorization. `SUITE_WORKSPACE_ID` is the single
workspace this deployment serves, so membership is granted directly through
`SignInUpService.signInUpOnExistingWorkspace` — the same call the SSO callback
ends up in — rather than gated on an invitation the way
`AuthService.checkAccessForSignIn` gates a workspace-level identity provider.
A Twenty user who already exists under that email **with a verified address** is
reused and simply added to the workspace; an existing member is a no-op.

The Clavis `sub` is recorded in `core."suiteUserIdentity"` (`issuer`, `subject`,
`userId`, unique on `(issuer, subject)`), created by the
`CreateSuiteUserIdentityCoreTable` fast instance command. It lives in its own
table rather than on `core."user"`: the mapping is specific to this module, a
suite-side email change must not orphan the Twenty user, and `issuer` keeps two
suites from colliding on a subject that is only unique within one of them. On a
later exchange the identity row wins over the email lookup, and the Twenty user
keeps its own email — that email is the subject of the login token and the key
the rest of Twenty's auth flows use.

A newly provisioned user gets Twenty's onboarding with the connect-account
(sync-email) step already skipped — a suite user has no mailbox in Twenty to
connect. *Create profile* is left as Twenty sets it, because the suite token
carries no name. The workspace-level `ONBOARDING_INVITE_TEAM_PENDING` flag is
deliberately not touched: only a user with invite permission clears it, and it
is the admin's decision, so the admin has to walk their own account through
onboarding once before exchanged members can get past `/invite-team`.

## Reusing a live session

The host page re-posts the exchange on every open, and minting is not free:
`issueSessionForTokenPair` creates a session and revokes the presented one as
`SUPERSEDED`. On a reload the frame still holds the old cookie, boots `/verify`
believing it is signed in, and fires authenticated queries in parallel with the
redemption; once the old session is revoked those fail and Apollo's
`onUnauthenticatedError` sends the frame to the sign-in page.

So before minting, the endpoint resolves the session cookie the request already
carries (`UserSessionCookieService` + `UserSessionService.resolveSession`). When
it is live and its payload's user and workspace are the ones being exchanged
into, no login token is issued and the response redirects straight to `next`.
An invalid, expired or mismatched session falls through to the normal mint path,
as does a first exchange (no identity row and no verified email match yet).
Rate limiting still runs first.

When the user was found by email rather than by an identity row, this path
records the `suiteUserIdentity` mapping before redirecting, so the reuse does
not leave the subject unlinked until some later exchange arrives without a
session.

## Security notes

- **Assertion-authenticated.** The endpoint is public (`PublicEndpointGuard`,
  `NoPermissionGuard`); the Clavis signature is the only credential it trusts.
- **CSRF-excluded.** It is listed in `CookieSessionCsrfMiddleware`'s exclusions
  next to the SAML callback, for the same reason: a cross-origin POST
  authenticated on the assertion rather than on the session cookie.
- **Origin-restricted** to `SUITE_HOST_ORIGIN`, which is what replaces the CSRF
  check the exclusion removes. Without it, any page holding a valid suite token
  could post it in a victim's browser: the exchange would mint a login token for
  the attacker's account and the victim's browser would redeem it, superseding
  its own session and leaving the victim working as the attacker's Twenty user.
  A missing `Origin` header is refused like a mismatching one, on the same
  reasoning as `CookieSessionCsrfMiddleware`: browsers send it on every
  cross-origin POST, so its absence is either a non-browser client or a stripped
  header that cannot be told apart from a forgery.
- **Length-capped.** A `subject_token` longer than 8192 characters is refused
  before anything parses it. The body limit is the global
  `settings.storage.maxFileSize`, so without the cap a client could post a
  multi-megabyte string that `jose` base64-decodes and parses before the
  signature check rejects it. A real Clavis EdDSA token is well under 4 KB.
- **Unexpected errors are not echoed.** Only an `AuthException` message reaches
  `?errorMessage=`; anything else is replaced with a generic message and
  reported through the exception handler, so a database error cannot leak a
  constraint or table name into the browser.
- **Rate-limited** to 300 exchanges per minute per client address through
  `ThrottlerService`. The budget is deliberately loose: the key is `req.ip`, so
  a whole office behind one NAT shares a single bucket, and the throttle runs
  before the service, so the session-reuse path every page reload takes is
  counted too. All it has to bound is JWT signature verification, which is
  cheap. Behind a reverse proxy the deployment must still set `TRUST_PROXY`:
  without it every client collapses into one bucket.
- **`next` is restricted** to a relative path that cannot express another origin
  (`//host`, `\host`) or smuggle control characters into the redirect header.
- **Turn Twenty's password sign-up off** (`AUTH_PASSWORD_ENABLED=false`) before
  enabling the exchange on an instance that untrusted people can reach. With
  password sign-up on and `IS_EMAIL_VERIFICATION_REQUIRED=false` (Twenty's
  default), anyone can register a victim's email address; the victim's first
  exchange would otherwise find that account by email and hand it the workspace
  while the squatter keeps password access to it. The exchange refuses to link a
  suite subject to an account whose email is unverified, which closes that path,
  but it also means such a collision leaves the legitimate user with no way in
  until the squatting account is deleted.
- **Clavis is trusted to assert verified emails only.** The reverse direction of
  the squatter case: first-time linking is by email, so a suite account whose
  address was never verified would take over the Twenty account owning it. A
  token carrying `email_verified: false` is refused, but a token without the
  claim is trusted, since Clavis is not known to issue it and refusing an absent
  claim would break every exchange. The whole provisioning path therefore rests
  on the assumption that Clavis never issues a token for an unverified address;
  it has to hold on the Clavis side.
- **Any holder of a suite access token can exchange it.** The token is the
  general-purpose suite bearer, so any suite backend holding one for a user could
  trade it for a Twenty session. That is inside the suite's trust boundary today;
  the stricter version is an audience-scoped token Clavis mints for the Twenty
  origin on request.
