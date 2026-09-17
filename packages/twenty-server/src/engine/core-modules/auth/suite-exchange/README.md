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

Re-run the exchange on every open: the login token is short-lived and the suite
refreshes its own access token independently.

## Configuration

| Variable                | Default     | Description                                                                                                |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `SUITE_EXCHANGE_ENABLED`| `false`     | Enables the endpoint. Everything below is required when this is true.                                        |
| `SUITE_ISSUER`          | —           | Expected `iss` claim — the browser-facing Clavis URL.                                                         |
| `SUITE_JWKS_URL`        | —           | Where the server fetches the JWKS, e.g. `http://clavis:3001/api/clavis/.well-known/jwks.json`.                |
| `SUITE_AUDIENCE`        | `ovh-suite` | Expected `aud` claim.                                                                                        |
| `SUITE_WORKSPACE_ID`    | —           | Workspace every exchanged user lands in.                                                                     |
| `SUITE_ORG_ID`          | unset       | Optional: the only suite organisation allowed to exchange, matched against the token's `org_id` claim.        |

`SUITE_ISSUER` and `SUITE_JWKS_URL` are two settings on purpose: the issuer
string is the URL browsers use, which typically does not resolve from inside the
server's network.

The group is hidden from the admin panel: an admin who can repoint
`SUITE_JWKS_URL` at a key set they control can mint a session for any email.

## Verification

Tokens are verified with `jose`, not Twenty's `JwtWrapperService`: Clavis signs
with EdDSA (Ed25519) and the `jsonwebtoken`-based wrapper only does HS256/ES256.
`iss`, `aud`, `exp` and the algorithm are all pinned, and a token without an
`email` claim is rejected. The remote key set handle is built once per JWKS URL —
`jose` caches the keys behind it and refetches when it meets an unknown `kid`.

`SUITE_ORG_ID` pins the suite organisation when it is set: a token whose
`org_id` differs (or is absent) is refused. Left unset, every organisation of
the issuer shares the one workspace — and each other's records.

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

## Security notes

- **Assertion-authenticated.** The endpoint is public (`PublicEndpointGuard`,
  `NoPermissionGuard`); the Clavis signature is the only credential it trusts.
- **CSRF-excluded.** It is listed in `CookieSessionCsrfMiddleware`'s exclusions
  next to the SAML callback, for the same reason: a cross-origin POST
  authenticated on the assertion rather than on the session cookie.
- **Rate-limited** per client address through `ThrottlerService`. The key is
  `req.ip`, so behind a reverse proxy the deployment must set `TRUST_PROXY` —
  without it every client collapses into one bucket and a single misbehaving
  tab locks the whole deployment out of the CRM for a minute at a time.
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
- **Any holder of a suite access token can exchange it.** The token is the
  general-purpose suite bearer, so any suite backend holding one for a user could
  trade it for a Twenty session. That is inside the suite's trust boundary today;
  the stricter version is an audience-scoped token Clavis mints for the Twenty
  origin on request.
