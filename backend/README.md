# Hull backend

A small Go server that holds the owner's Anthropic API key. People make an account (email and password). Apps
(Hull and the owner's other apps) sign people in through the browser, get a token, and call an
Anthropic-compatible and an OpenAI-compatible API with it. The server forwards to Anthropic with the owner's key;
the key never leaves the server.

## Run

Settings live in the repo root's `.env` (copy `.env.example` there and fill in ANTHROPIC_API_KEY and, for Google sign-in, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET). `pnpm dev` reads it, starts the server, waits for /healthz and then starts the Hull app with HULL_BACKEND_URL; the app never gets the server's secrets.

```sh
# from the repo root
cp .env.example .env      # once; then fill in the keys
pnpm dev                  # this server, then the Hull app pointed at it
pnpm dev --no-app         # this server alone
```

Without `ANTHROPIC_API_KEY` the server still starts: sign-in works and the AI routes answer 503.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | The owner's key. Required for the AI routes. |
| `ADDR` | `127.0.0.1:8787` | Listen address. |
| `DATA_DIR` | `./data` | Holds `hull.db` (SQLite, only when `DATABASE_URL` is not set) and the community game files. |
| `DATABASE_URL` | none | `postgres://user:password@host:5432/db?sslmode=verify-full&sslrootcert=/path/ca.pem`. Set: Postgres. Unset: SQLite. A secret; never printed. |
| `DATABASE_SCHEMA` | `public` | Postgres schema that holds the tables (plain identifier). Unused with SQLite. |
| `SITE_ORIGINS` | `https://marlstudio.com,https://www.marlstudio.com` | Web origins allowed to call `POST /api/waitlist` from a browser (CORS). |
| `ADMIN_EMAILS` | none | Comma-separated accounts that may open `/admin`. Empty: no admins. |
| `PUBLIC_URL` | `http://127.0.0.1:8787` | Used in pages; `https` turns on the Secure cookie flag. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Where requests are forwarded. |
| `ALLOW_SIGNUP` | `true` | Set `false` to close sign-up. |
| `DEFAULT_MODEL` | `claude-opus-5-5` | Used by `/v1/chat/completions` when the model is not a `claude-*` name. |
| `ALLOWED_MODELS` | `claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5` | The `claude-*` names the AI routes forward (the default model is always allowed). Anything else answers 400. |
| `DAILY_TOKEN_BUDGET` | `2000000` | Input plus output tokens one user may use per UTC day; past it the AI routes answer 429. `0` turns the cap off. |
| `AI_REQUESTS_PER_MINUTE` | `30` | AI requests per user per minute (burst the same). `0` turns the cap off. |
| `TRUSTED_PROXIES` | none | Comma-separated IPs or CIDRs of your reverse proxy. Only from these is `X-Forwarded-For` believed (read from the right). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Turn on "Continue with Google". Set both or neither; one alone stops the server at startup. |

Test: `go vet ./... && go test ./...` (SQLite in memory). With `TEST_DATABASE_URL=postgres://...` set, the same suites run against Postgres, each test in a schema of its own that is dropped afterwards. Behind a reverse proxy, set `TRUSTED_PROXIES`: the per-IP limits on login, sign-up and the catalog use the
connection's address unless it is a trusted proxy, then the nearest `X-Forwarded-For` address that is not one.

## Database

With no `DATABASE_URL` the server uses SQLite at `DATA_DIR/hull.db` (local development, `pnpm dev`; nothing to install). With it set, it uses Postgres through
pgx (`database/sql`); community game files stay on disk under `DATA_DIR` either way. Every SQL statement is written once with `?` placeholders and rewritten to
`$1..` for Postgres; times are Unix seconds in integer columns on both.

The schema is applied at start, never by hand: `CREATE TABLE IF NOT EXISTS` for every table, inside one transaction that first takes a Postgres advisory lock, so two
processes starting together apply it one after the other. The `hull_schema` table records the version (`version`, `applied_at`); a later change adds a
migration step and raises the number. A SQLite file made before Google sign-in gets its `google_sub` column added on open; Postgres has it from the start.
`DATABASE_SCHEMA` (default `public`) is created if missing and put first in the connection's `search_path`, so this server can share a database instance.

TLS follows the URL as pgx reads it: `sslmode=verify-full&sslrootcert=/path/to/rds-ca.pem` checks the server's certificate and name. The pool holds at most 8 connections
(4 idle, recycled after 30 minutes), a connection attempt gives up after 10 s, and start-up pings the database: a failure names `DATABASE_URL`,
the host and the database name, never the URL.

```sh
hull-backend migrate      # open the database, apply the schema, print what was created and the schema version; the deploy runs it first
```

## Waitlist

`POST /api/waitlist`, JSON body `{"email": string, "source"?: string, "company"?: string}`.

- `email`: trimmed, lower-cased, at most 254 characters, one `@`, a dotted domain, no spaces. Otherwise 400 `{"error":"invalid_email"}`.
- `source`: where the form was; letters, digits, `-` and `_`, at most 64; anything else is stored as an empty string. The site sends `"home"`.
- `company`: a honeypot. Non-empty: answer 200 `{"ok":true}` and store nothing.
- A new address and one already listed both answer 200 `{"ok":true}`, so the form never reveals who is on the list.
- More than 5 requests a minute from one client IP (see `TRUSTED_PROXIES`): 429 `{"error":"rate_limited"}` with `Retry-After` in seconds.
  A body over 4 KB or not a JSON object: 400 `{"error":"invalid_request"}`. A database failure: 500 `{"error":"server_error"}`.
- CORS, on this route only: for an `Origin` listed in `SITE_ORIGINS` the answer carries `Access-Control-Allow-Origin: <that origin>` and `Vary: Origin`;
  `OPTIONS` (preflight) answers 204 with `Allow-Methods: POST, OPTIONS`, `Allow-Headers: Content-Type` and `Max-Age: 600`. Other origins get no CORS
  headers; credentials are never allowed. The site calls it with `fetch(..., {method:"POST", headers:{"Content-Type":"application/json"}, credentials:"omit"})`.

The `waitlist` table holds `id`, `email` (unique), `source` and `created_at`. No IP address and no user agent is stored.

## Admin

An admin is a signed-in account (the same `hull_session` cookie) whose email is in `ADMIN_EMAILS`. To become one: put your address there, restart, make an
account with that address at `/signup` (or sign in at `/login`, Google included), then open `/admin`. Empty setting, no admins.

- `GET /admin`: waitlist total, today and last 7 days, a 14-day table, the newest 200 addresses; accounts total and the newest 50; active tokens; AI usage today and
  over 7 days and the top 10 accounts by tokens today; community games and versions; database kind, schema version, start time, Go version. All times are UTC; "today" is the UTC
  calendar day and "last 7 days" is today and the six days before.
- `GET /admin/waitlist.csv`: the whole waitlist (`email,source,created_at` as ISO 8601 UTC), `Content-Disposition: attachment`, `Cache-Control: no-store`.
  A cell that starts with `=`, `+`, `-` or `@` gets a leading `'` so a spreadsheet does not run it.
- `GET /api/admin/stats`: the same numbers as JSON (cookie session; a Bearer token is not enough).

Everyone who is not an admin, signed in or not, gets the same 404 an unknown path gets, and a signed-out visit is not redirected to `/login`, so the routes do not show
themselves. Sign in at `/login` first.

## Deploy

Files for a Linux host (Caddy in front, systemd, RDS Postgres) are in `deploy/`. Nothing here connects to a server; the steps are done by hand, in this order:

1. `deploy/build.sh` makes `dist/hull-backend-linux-arm64`, a static linux/arm64 binary, and prints its size and sha256.
2. On the host: make the system user `hull` (no login), copy the binary to `/usr/local/bin/hull-backend`, and compare its sha256 with the one printed.
3. Create the database and a login role for it on the Postgres instance (the role owns the database, or the schema named in `DATABASE_SCHEMA`). Put the RDS CA bundle at
   `/etc/hull-backend/rds-ca.pem`.
4. Fill in `/etc/hull-backend/db.env` and `/etc/hull-backend/backend.env` from `deploy/db.env.template` and `deploy/backend.env.template` (owner root, group hull, mode 0640).
5. Run `hull-backend migrate` as user hull with both files loaded; it creates the tables or says they are in place, and stops here if the URL, TLS or grants are wrong.
6. Install `deploy/hull-backend.service` into `/etc/systemd/system/`, then `systemctl daemon-reload && systemctl enable --now hull-backend`; check `curl 127.0.0.1:8787/healthz`.
7. Add `deploy/Caddyfile.snippet` to the Caddyfile and reload Caddy (it must not buffer: AI answers stream). Point `api.marlstudio.com` at the host first so Caddy can get its certificate.
8. Make your account at `https://api.marlstudio.com/signup` (its address is in `ADMIN_EMAILS`) and open `/admin`. Send a test sign-up from the site and read it back there.

To update: build, copy the binary over the old one, run `hull-backend migrate`, then `systemctl restart hull-backend`. The server drains for up to 20 s on stop.

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

## Community games

A public, versioned catalog of games the app can list and download. Files live in `DATA_DIR/community/<id>/<version>/`
(`game.tar.gz`, and `cover.webp|jpg|png` when there is one) and rows in the `community_versions` table
(added to an existing database on start). `id` is 1 to 40 of `a-z0-9-`; `version` is `MAJOR.MINOR.PATCH`, compared as
numbers (1.10.0 is newer than 1.9.0). A version is never overwritten.

Publish on the server's machine, with the same `DATA_DIR` the server uses (the same binary; with no subcommand it serves):

```sh
hull-backend community publish --dir <game folder> [--id <id>] [--version <x.y.z>] [--note <text>]
hull-backend community list
hull-backend community remove --id <id> --version <x.y.z>
```

`publish` reads `id`, `title`, `note` and `version` from `hull.json` in the folder when the flags are absent. It refuses a
version that already exists or is not greater than the latest. The folder is packed as `tar.gz` with relative paths and
file modes kept; `node_modules/` and `.git/` (anywhere), `.hull/` and `dist/` (at the top), every `.env*` file, the
cover files and symlinks are left out. A top-level `cover.webp`, `cover.jpg` or `cover.png` (in that order) is stored beside
the archive. It prints the id, version, size and sha256.

HTTP, public, GET only, 120 requests a minute per IP:

- `GET /api/community`: `{"games":[{"id","title","note","version","published_at","size","sha256","cover_url","download_url","versions"}]}`.
  The fields are the newest version's; `versions` lists all, newest first; games are sorted by title. `cover_url` is
  `null` without a cover. URLs are absolute, built from `PUBLIC_URL`.
- `GET /api/community/{id}/cover`: the newest version's cover, 404 when it has none (`Cache-Control: public, max-age=3600`).
- `GET /api/community/{id}/{version}/cover`: that version's cover.
- `GET /api/community/{id}/{version}/game.tar.gz`: the archive. `Content-Type: application/gzip`, `Content-Length`,
  `ETag` (the sha256, quoted), `X-Hull-Sha256`, immutable cache, Range supported. 404 for an unknown id or version; path
  segments are checked against the id and version rules before any file is touched.

## Protocol

Web pages (cookie session, HttpOnly, SameSite=Lax, CSRF token on every form): `/signup`, `/login`, `POST /logout`,
`/` (account: apps signed in with Revoke, token usage this month), `/admin` (see Admin).

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
