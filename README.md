# bettygo

A Cloudflare Workers microservice that handles Discord OAuth2 verification for a webapp. The webapp calls bettygo's API to initiate the Discord connect flow and to query a user's live guild membership status. bettygo is stateless — it stores nothing; all persistence is the caller's responsibility.

**What bettygo does:**
- Generates Discord OAuth2 authorization URLs (bound to a webapp user ID via HMAC-signed state)
- Handles the Discord OAuth2 callback (code exchange, Discord user fetch) and redirects the browser back to the webapp with the Discord user ID
- Checks live guild membership on demand via the Discord bot token

**What bettygo does NOT do:**
- Store anything — no KV, no database
- Manage user accounts or sessions
- Issue JWTs or cookies
- Cache verification status (every `/users/:userId/discord` call hits the Discord API)

---

## Stack

- **Runtime**: [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- **Framework**: [Hono](https://hono.dev/)
- **Discord**: native `fetch()` + [`discord-api-types`](https://github.com/discordjs/discord-api-types) for types

> **Note:** bettygo uses native `fetch()` for all Discord API calls instead of `@discordjs/rest`. That package pulls in Node.js-specific dependencies (`node-inspect-extracted`) that break in the CF Workers runtime at startup. The Discord REST API is plain HTTP — no SDK needed.

---

## Project structure

```
src/
├── index.ts              # Entry point — CORS, route registration, API key middleware
├── types.ts              # Env interface (all environment variable types)
├── middleware/
│   └── apiKey.ts         # X-Api-Key header check for protected routes
├── routes/
│   ├── auth.ts           # GET /auth/login, GET /auth/callback
│   └── users.ts          # GET /users/:userId/discord
└── lib/
    ├── discord.ts        # Discord REST helpers (token exchange, user fetch, guild check)
    └── state.ts          # Stateless CSRF state: HMAC-SHA256 over timestamp + userId
```

---

## The two redirect URIs — read this first

This is the most common point of confusion when setting up bettygo. There are **two** redirect URIs and they point to completely different places.

```
User → Discord → bettygo/auth/callback → yourapp.com/discord-callback
                        ↑                          ↑
              DISCORD_REDIRECT_URI          WEBAPP_REDIRECT_URI
          (registered in Discord portal)    (your frontend page)
```

| Variable | Points to | Registered where |
|---|---|---|
| `DISCORD_REDIRECT_URI` | bettygo's `/auth/callback` endpoint | Discord Developer Portal → OAuth2 → Redirects |
| `WEBAPP_REDIRECT_URI` | Your frontend's callback page | Nowhere — bettygo uses it internally |

**Common mistake:** registering `https://yourapp.com/discord-callback` (the webapp URL) in the Discord Developer Portal. Discord never redirects there — only bettygo does. What Discord needs registered is the **worker URL**: `https://bg.zel.kim/auth/callback`.

---

## Environment variables

Plain vars live in `wrangler.jsonc`. Secrets are set with `wrangler secret put` (or `npm run secrets:push` — see Setup).

| Variable | Kind | Description |
|----------|------|-------------|
| `DISCORD_CLIENT_ID` | var | OAuth2 application client ID |
| `DISCORD_CLIENT_SECRET` | secret | OAuth2 application client secret |
| `DISCORD_BOT_TOKEN` | secret | Bot token used to check guild membership server-side |
| `DISCORD_GUILD_ID` | var | ID of the Discord guild to check membership against |
| `DISCORD_REDIRECT_URI` | var | Full URL of `/auth/callback` **on this worker** — must exactly match what is registered in the Discord Developer Portal |
| `WEBAPP_REDIRECT_URI` | var | Comma-separated list of allowed webapp callback URLs. bettygo redirects the browser here after OAuth (e.g. `https://yourapp.com/discord-callback,http://localhost:3000/discord-callback`) |
| `HMAC_SECRET` | secret | Random string used to sign CSRF state tokens. Generate with `openssl rand -hex 32` |
| `API_SECRET` | secret | Shared secret the webapp sends as `X-Api-Key` on protected endpoints |
| `ALLOWED_ORIGIN` | var | Comma-separated list of webapp origins for CORS (e.g. `https://yourapp.com,http://localhost:3000`). Defaults to `*` if empty |

---

## API reference

### Authentication

Protected endpoints require:
```
X-Api-Key: <API_SECRET>
```
Missing or wrong key → `401 { "error": "Unauthorized" }`.

Public endpoints (`/health`, `/auth/callback`) do not require this header — they are called by the browser or by Discord directly.

---

### `GET /health`

Liveness check. No auth required.

**Response**
```json
{ "ok": true }
```

---

### `GET /auth/login?user_id=<id>[&redirect_uri=<uri>]`

**Protected.** Returns the Discord OAuth2 authorization URL for the given webapp user. The webapp backend calls this, then redirects the user's browser to the returned URL.

**Query params**

| Param | Required | Description |
|-------|----------|-------------|
| `user_id` | yes | The webapp's internal user ID. Embedded in the OAuth state so bettygo can tie the Discord identity back to this user after the callback. |
| `redirect_uri` | no | Which webapp callback URL to redirect to after OAuth. Must be one of the values in `WEBAPP_REDIRECT_URI`. Defaults to the first entry. Use this to send localhost traffic to `http://localhost:3000/discord-callback` while production traffic goes to `https://yourapp.com/discord-callback`. |

**Headers**
```
X-Api-Key: <API_SECRET>
```

**Success response — 200**
```json
{
  "url": "https://discord.com/oauth2/authorize?client_id=...&scope=identify+guilds.members.read&state=..."
}
```

**Error responses**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "error": "Missing user_id" }` | `user_id` query param not provided |
| 400 | `{ "error": "Invalid redirect_uri" }` | `redirect_uri` not in the allowed list |
| 401 | `{ "error": "Unauthorized" }` | Missing or wrong `X-Api-Key` |

---

### `GET /auth/callback?code=<code>&state=<state>`

**Public.** Discord redirects the user's browser here after authorization. This endpoint:
1. Verifies the HMAC state and extracts the webapp `user_id` and `redirect_uri`
2. Exchanges the code for a Discord access token
3. Fetches the Discord user profile
4. Redirects the browser to the appropriate `WEBAPP_REDIRECT_URI` with the Discord user ID

Guild membership is **not** checked here — call `GET /users/:userId/discord` separately when you need live verification.

**Do not call this from your backend** — it is a browser redirect target.

**Redirect on success**
```
{WEBAPP_REDIRECT_URI}?user_id=<webapp_user_id>&discord_id=<discord_snowflake>
  &discord_username=<username>&discord_display_name=<display_name>&discord_avatar=<avatar_hash>
  &ts=<unix_ms>&sig=<hex_hmac>
```

| Param | Description |
|-------|-------------|
| `user_id` | The webapp user ID passed to `/auth/login` |
| `discord_id` | Discord snowflake |
| `discord_username` | Discord handle (empty string if absent) |
| `discord_display_name` | Discord global name (empty string if absent) |
| `discord_avatar` | Discord avatar hash (empty string if absent) |
| `ts` | Millisecond timestamp the redirect was signed |
| `sig` | HMAC-SHA256 hex over `{ts}.{user_id}.{discord_id}.{discord_username}`, keyed with `API_SECRET` |

The webapp must recompute `sig` and reject stale `ts` values before trusting any of these params.

**Redirect on error**
```
{WEBAPP_REDIRECT_URI}?error=<reason>
```

| `error` value | Cause |
|---------------|-------|
| `oauth_denied` | User cancelled the Discord authorization |
| `missing_params` | Malformed redirect from Discord |
| `invalid_state` | CSRF check failed or state older than 10 minutes |
| `token_exchange_failed` | Discord rejected the authorization code |
| `user_fetch_failed` | Could not fetch Discord user profile |

---

### `GET /users/:userId/discord`

**Protected.** Checks live guild membership for a Discord user. `:userId` must be a Discord user snowflake ID (obtained from the `/auth/callback` redirect params).

Every call hits the Discord API — bettygo stores nothing. The caller is responsible for caching or persisting the result.

**Headers**
```
X-Api-Key: <API_SECRET>
```

**Response — 200**
```json
{ "verified": true }
```
```json
{ "verified": false }
```

`verified: true` means the user is currently a member of `DISCORD_GUILD_ID`.
`verified: false` means the user is not a member (Discord returned 404).

**Error responses**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "error": "invalid_discord_id" }` | `:userId` is not a valid Discord snowflake |
| 401 | `{ "error": "Unauthorized" }` | Missing or wrong `X-Api-Key` |
| 500 | `{ "error": "bot_auth_failed" }` | Bot token rejected by Discord (401/403) — misconfigured `DISCORD_BOT_TOKEN` |
| 502 | `{ "error": "guild_check_failed" }` | Unexpected error from Discord API |

---

## Full OAuth2 flow

```
Webapp backend                  bettygo                      Discord
─────────────                   ───────                      ───────
GET /auth/login?user_id=abc ──►
                                generate HMAC state
                            ◄── { url: "discord.com/oauth2/authorize?...state=ts.abc.sig" }

Webapp redirects user's browser to Discord URL

                                                   User logs in on Discord
                                                   Discord ──► GET /auth/callback
                                                                ?code=xxx&state=ts.abc.sig
                                verify HMAC state → extract user_id = "abc"
                                exchange code ──► Discord
                                             ◄── access_token
                                GET /users/@me ──► Discord
                                              ◄── { id: "1234567890", username, ... }
                                302 ──► WEBAPP_REDIRECT_URI?user_id=abc&discord_id=1234567890

User's browser lands on webapp callback page
Webapp saves discord_id="1234567890" to its own DB, then checks membership:

Webapp backend                  bettygo                      Discord
─────────────                   ───────                      ───────
GET /users/1234567890/discord ──►
                                GET /guilds/{guildId}/members/1234567890 ──► Discord
                                                                           ◄── 200 or 404
                            ◄── { verified: true }

Webapp backend updates its own DB: discord_verified = true
```

---

## Webapp integration walkthrough

All steps labelled "webapp backend" are server-side. Never call protected endpoints from the browser — `API_SECRET` must stay server-side only.

### Step 1 — Initiate the Discord connect flow

When the user clicks "Connect Discord", your **webapp backend** calls:

```js
const res = await fetch(
  `https://bg.zel.kim/auth/login?user_id=${user.id}&redirect_uri=${encodeURIComponent(callbackUrl)}`,
  { headers: { "X-Api-Key": process.env.BETTYGO_API_SECRET } }
);
const { url } = await res.json();
// redirect user's browser to `url`
```

`callbackUrl` should be whichever frontend page will handle the result — e.g. `http://localhost:3000/discord-callback` in dev or `https://yourapp.com/discord-callback` in production. It must be in the `WEBAPP_REDIRECT_URI` list.

### Step 2 — Handle the callback page (frontend)

bettygo redirects the user's browser to your callback page with the Discord user ID:

```ts
const params = new URLSearchParams(window.location.search);

if (params.has("error")) {
  const error = params.get("error"); // e.g. "oauth_denied"
  // show error state, let user retry
} else {
  const userId = params.get("user_id");       // your webapp user ID
  const discordId = params.get("discord_id"); // Discord snowflake — save this
  // notify your backend to store discord_id and check membership
}
```

### Step 3 — Save the Discord ID and check membership (webapp backend)

Your backend should save `discord_id` to its own database and then call bettygo to get live verification status:

```js
// Save discord_id to your DB first, then:
const res = await fetch(`https://bg.zel.kim/users/${discordId}/discord`, {
  headers: { "X-Api-Key": process.env.BETTYGO_API_SECRET },
});
const { verified } = await res.json();
// update your own DB: discord_verified = verified
```

### Step 4 — Re-check membership on demand (optional)

Since bettygo is stateless, you can call `GET /users/:discordId/discord` at any time to get a fresh membership check — no re-OAuth required:

```js
const res = await fetch(`https://bg.zel.kim/users/${storedDiscordId}/discord`, {
  headers: { "X-Api-Key": process.env.BETTYGO_API_SECRET },
});
const { verified } = await res.json();
```

---

## Setup

### 1. Discord Developer Portal

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application
2. Under **OAuth2 → Redirects**, add the worker's callback URL — **not your webapp URL**:
   - Production: `https://bg.zel.kim/auth/callback`
   - Local dev: `http://localhost:8787/auth/callback`
3. Copy the **Client ID** and **Client Secret**
4. Under **Bot**, create a bot and copy the **Bot Token**
5. Invite the bot to your guild with the `bot` scope (no special permissions needed — it only reads member data)

> **Critical:** The URL you register in the Discord portal must exactly match `DISCORD_REDIRECT_URI` in your config. A mismatch causes Discord to return `Invalid OAuth2 redirect_uri` immediately after the user authorizes.

### 2. Configure vars in `wrangler.jsonc`

```jsonc
"vars": {
  "DISCORD_CLIENT_ID": "your_client_id",
  "DISCORD_GUILD_ID": "your_guild_id",
  "DISCORD_REDIRECT_URI": "https://bg.zel.kim/auth/callback",
  "WEBAPP_REDIRECT_URI": "https://yourapp.com/discord-callback,http://localhost:3000/discord-callback",
  "ALLOWED_ORIGIN": "https://yourapp.com,http://localhost:3000"
}
```

### 3. Set secrets

Copy `.dev.vars.example` to `.dev.vars` and fill in values for local dev:

```bash
cp .dev.vars.example .dev.vars
```

For production, push secrets to Cloudflare with the helper script:

```bash
npm run secrets:push
```

This reads `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `HMAC_SECRET`, and `API_SECRET` from `.env` and uploads each with `wrangler secret put`. You can also target a different file:

```bash
npm run secrets:push -- .env.production
```

Or push manually:

```bash
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put HMAC_SECRET    # generate: openssl rand -hex 32
npx wrangler secret put API_SECRET     # share this with your webapp backend
```

### 4. Local dev

For local development, wrangler reads secrets from `.dev.vars` (gitignored) automatically. Set `DISCORD_REDIRECT_URI` in `.env` / `.dev.vars` to the local worker URL:

```
DISCORD_REDIRECT_URI=http://localhost:8787/auth/callback
```

And make sure `http://localhost:8787/auth/callback` is registered in the Discord Developer Portal (in addition to the production URL).

```bash
npm run dev    # starts worker at http://localhost:8787
```

### 5. Deploy

```bash
npm run deploy
```

---

## Common pitfalls

**`Invalid OAuth2 redirect_uri` from Discord**
The `redirect_uri` in the OAuth request doesn't match any URL registered in the Discord Developer Portal. Check that `DISCORD_REDIRECT_URI` (the worker URL, e.g. `https://bg.zel.kim/auth/callback`) is registered — not the webapp URL. For local dev, `http://localhost:8787/auth/callback` must also be registered.

**`bot_auth_failed` (500) from `/users/:userId/discord`**
The `DISCORD_BOT_TOKEN` secret is missing or invalid. Check it with `wrangler secret list` and re-set it with `wrangler secret put DISCORD_BOT_TOKEN`.

**`invalid_discord_id` (400) from `/users/:userId/discord`**
The `:userId` path param must be a Discord snowflake (e.g. `123456789012345678`), not a webapp user ID or UUID. Pass the `discord_id` received from the `/auth/callback` redirect params.

**Worker crashes at startup with `Super expression must either be null or a function`**
A dependency is importing Node.js-specific classes that don't exist in the CF Workers runtime. bettygo uses native `fetch()` instead of `@discordjs/rest` specifically to avoid this. If you add new npm packages, check they are CF Workers compatible — avoid anything that extends Node.js built-ins (`EventEmitter`, `stream`, etc.).

**OAuth state expired (`invalid_state` error)**
The HMAC state is valid for 10 minutes. If the user takes longer than that on the Discord authorization page, the callback will fail. Redirect the user back to the login flow.

**CORS errors in the browser**
The request origin is not in `ALLOWED_ORIGIN`. Add the missing origin to the comma-separated list in `wrangler.jsonc` and redeploy. Remember that `ALLOWED_ORIGIN` controls which origins can call bettygo's API from the browser — for server-to-server calls from your backend, CORS doesn't apply.

---

## Security notes

- **CSRF protection**: the OAuth `state` is HMAC-SHA256 signed over `timestamp.userId`. It expires after 10 minutes and requires knowledge of `HMAC_SECRET` to forge — no database or KV needed for state storage.
- **API key**: protected endpoints require `X-Api-Key` matching `API_SECRET`. This must only be used server-side — never expose it to the browser.
- **Guild membership**: checked server-side using the bot token. Users cannot spoof membership by manipulating client-side state.
- **Redirect URI validation**: the optional `redirect_uri` param on `/auth/login` is validated against the `WEBAPP_REDIRECT_URI` allowlist before being encoded in the signed state. An arbitrary redirect URI cannot be injected.
- **Secrets**: `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `HMAC_SECRET`, and `API_SECRET` are set via `wrangler secret put` and are never in source control or `wrangler.jsonc`.

## Contributing
TBA
