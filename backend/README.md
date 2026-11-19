# Hull backend

A small Go server that holds the owner's Anthropic API key. People make an account (email and password). Apps
(Hull and the owner's other apps) sign people in through the browser, get a token, and call an
Anthropic-compatible and an OpenAI-compatible API with it. The server forwards to Anthropic with the owner's key;
the key never leaves the server.

## Run

```sh
cd backend
cp .env.example .env      # then fill in ANTHROPIC_API_KEY; the server reads the environment, not the file
set -a; . ./.env; set +a
go run ./cmd/hull-backend
```

Without `ANTHROPIC_API_KEY` the server still starts: sign-in works and the AI routes answer 503.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | The owner's key. Required for the AI routes. |
| `ADDR` | `127.0.0.1:8787` | Listen address. |
| `DATA_DIR` | `./data` | Holds `hull.db` (SQLite). |
| `PUBLIC_URL` | `http://127.0.0.1:8787` | Used in pages; `https` turns on the Secure cookie flag. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Where requests are forwarded. |
| `ALLOW_SIGNUP` | `true` | Set `false` to close sign-up. |
| `DEFAULT_MODEL` | `claude-opus-5-5` | Used by `/v1/chat/completions` when the model is not a `claude-*` name. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Turn on "Continue with Google". Set both or neither; one alone stops the server at startup. |

Test: `go vet ./... && go test ./...`. Behind a reverse proxy, note that the per-IP limit on login and sign-up uses the
connection's address, not `X-Forwarded-For`.

## Google sign-in

1. In Google Cloud Console, make an OAuth client (type Web application) and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
2. Add `PUBLIC_URL` + `/api/v1/auth/google/callback` to the client's Authorized redirect URIs. For a local run that is
   `http://127.0.0.1:8787/api/v1/auth/google/callback`. The URI must match exactly, so `localhost` and `127.0.0.1` are different.

Without both variables there is no Google button and `/auth/google/start` answers 503. With them, the login and sign-up pages
show the button, which goes `/auth/google/start?next=...` (same `next` rule as `/login`) to Google and back to
`/api/v1/auth/google/callback`; the app sign-in works through it unchanged. State and the PKCE verifier wait in a 10-minute
HttpOnly cookie. The id token is read, not signature-checked, because it comes straight from Google over TLS in answer to a request
that carries the client secret; issuer, audience, expiry and a verified email are checked.

Which account signs in:

1. The account already linked to that Google user.
2. Else an account with that email. It is linked only when Google is the authority for the address: it ends in
   `@gmail.com` or `@googlemail.com`, or the token's `hd` (Workspace domain) equals the address's domain. Otherwise it is
   refused ("Sign in with your password"), so an unproven Google address cannot take over a password account.
3. Else a new account with no password (refused when `ALLOW_SIGNUP=false`).

A Google-only account cannot log in with a password. An existing database is migrated on start (a nullable, unique `google_sub` column).

## Protocol

Web pages (cookie session, HttpOnly, SameSite=Lax, CSRF token on every form): `/signup`, `/login`, `POST /logout`,
`/` (account: apps signed in with Revoke, token usage this month).

App sign-in (OAuth 2.0 authorization code with PKCE S256, loopback redirect per RFC 8252):

- `GET /oauth/authorize?response_type=code&client_id=<name>&redirect_uri=<uri>&state=<s>&code_challenge=<c>&code_challenge_method=S256`.
  `redirect_uri` must be `http://127.0.0.1:<port>/<path>` or `http://localhost:<port>/<path>`; anything else is a 400 page.
  `client_id` is the app's display name (1 to 40 of `a-z0-9-`). Not logged in: redirect to `/login?next=...`. Logged in: a consent page.
  Allow redirects to `redirect_uri?code=...&state=...`; Cancel to `redirect_uri?error=access_denied&state=...`.
  Codes are single use, last 5 minutes and are bound to user, client, redirect and challenge.
- `POST /oauth/token` (form or JSON) with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`
  gives `{"access_token":"hull_...","token_type":"Bearer","account":{"email":"..."}}`, or 400 `{"error":"invalid_grant",...}`.
  Tokens are long-lived and revocable; only their SHA-256 is stored.
- `GET /api/me` (Bearer) gives `{"email","created_at"}`. `POST /api/logout` (Bearer) revokes the token (204).

AI API (token in `x-api-key` or `Authorization: Bearer`):

- `POST /v1/messages`, `POST /v1/messages/count_tokens`: Anthropic passthrough. Body unchanged, `anthropic-version`
  (default `2023-06-01`) and `anthropic-beta` forwarded, streams copied without buffering, status and errors copied.
  Input and output tokens are recorded per user.
- `POST /v1/chat/completions`: OpenAI Chat Completions translated to Anthropic and back (system and developer messages,
  images as data URLs, tools and tool results, `tool_choice`, `stop`, streaming with tool-call argument deltas and
  `stream_options.include_usage`). Errors use OpenAI's shape.
- `GET /v1/models`: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`.
- `GET /healthz`: `ok`.

## Using it from another app

Anthropic SDK:

```python
import anthropic
client = anthropic.Anthropic(base_url="http://127.0.0.1:8787", api_key=HULL_TOKEN)
```

OpenAI SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=HULL_TOKEN)
```

## Sign-in flow for an app

1. Start a listener on `127.0.0.1` on a free port. Make a random `code_verifier` (43 to 128 characters of
   `A-Za-z0-9-._~`), `code_challenge = base64url(sha256(code_verifier))` without padding, and a random `state`.
2. Open the system browser at `/oauth/authorize` with your `client_id`, `redirect_uri=http://127.0.0.1:<port>/callback`,
   `state`, `code_challenge` and `code_challenge_method=S256`.
3. The person logs in or signs up, then clicks Allow. The browser is sent to your listener with `code` and `state`.
   Check `state`, then respond with a page that says they can close the tab.
4. `POST /oauth/token` with the code, the same `redirect_uri` and `client_id`, and `code_verifier`. Keep `access_token`
   in the OS keychain and send it as the API key. A 401 from the API means it was revoked: sign in again.
