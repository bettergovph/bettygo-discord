# bettygo

A Cloudflare Workers microservice that handles Discord OAuth2 verification for a webapp. The webapp calls bettygo's API to initiate the Discord connect flow and to query a user's Discord connection status. bettygo stores the result in Cloudflare KV and redirects the user's browser back to the webapp.

**What bettygo does:**
- Generates Discord OAuth2 authorization URLs (bound to a webapp user ID)
- Handles the Discord OAuth2 callback (code exchange, guild membership check)
- Stores the Discord connection in KV, keyed by webapp user ID
- Redirects the user's browser back to the webapp after the OAuth flow
- Exposes endpoints for the webapp to query and delete a user's Discord connection

**What bettygo does NOT do:**
- Manage user accounts or sessions
- Issue JWTs or cookies
- Store access/refresh tokens (only stores the resulting profile and verification status)

---

## Stack

- **Runtime**: [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- **Framework**: [Hono](https://hono.dev/)
- **Storage**: [Cloudflare KV](https://developers.cloudflare.com/kv/) — persists Discord connections by webapp user ID
- **Discord**: [`@discordjs/rest`](https://github.com/discordjs/discord.js/tree/main/packages/rest) + [`discord-api-types`](https://github.com/discordjs/discord-api-types)

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
│   └── users.ts          # GET /users/:userId/discord, DELETE /users/:userId/discord
└── lib/
    ├── discord.ts        # Discord REST helpers (token exchange, user fetch, guild check)
    ├── kv.ts             # KV read/write/delete helpers for Discord connections
    └── state.ts          # Stateless CSRF state: HMAC-SHA256 over timestamp + userId
```

---

## Environment variables

Set plain vars in `wrangler.jsonc`. Set secrets with `wrangler secret put <NAME>`.

| Variable | Kind | Description |
|----------|------|-------------|
| `DISCORD_CLIENT_ID` | var | OAuth2 application client ID |
| `DISCORD_CLIENT_SECRET` | secret | OAuth2 application client secret |
| `DISCORD_BOT_TOKEN` | secret | Bot token used to check guild membership server-side |
| `DISCORD_GUILD_ID` | var | ID of the Discord guild to check membership against |
| `DISCORD_REDIRECT_URI` | var | Full URL of `/auth/callback` on this worker (must match Discord app settings) |
| `WEBAPP_REDIRECT_URI` | var | URL on the webapp where bettygo redirects the browser after OAuth (e.g. `https://yourapp.com/discord-callback`) |
| `HMAC_SECRET` | secret | Random string used to sign CSRF state tokens |
| `API_SECRET` | secret | Shared secret the webapp sends as `X-Api-Key` on protected endpoints |
| `ALLOWED_ORIGIN` | var | Webapp origin for CORS (e.g. `https://yourapp.com`). Defaults to `*` if empty |
| `DISCORD_KV` | KV binding | KV namespace for storing Discord connections (configure in `wrangler.jsonc`) |

---

## API reference

### Authentication

Protected endpoints require the header:
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

### `GET /auth/login?user_id=<id>`

**Protected.** Returns the Discord OAuth2 authorization URL for the given webapp user. The webapp backend calls this, then redirects the user's browser to the returned URL.

**Query params**

| Param | Required | Description |
|-------|----------|-------------|
| `user_id` | yes | The webapp's internal user ID. This is embedded in the OAuth state so bettygo can tie the Discord identity back to this user after the callback. |

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
| 401 | `{ "error": "Unauthorized" }` | Missing or wrong `X-Api-Key` |

---

### `GET /auth/callback?code=<code>&state=<state>`

**Public.** Discord redirects the user's browser here after authorization. This endpoint:
1. Verifies the HMAC state and extracts the webapp `user_id`
2. Exchanges the code for a Discord access token
3. Fetches the Discord user profile
4. Checks if the user is a member of `DISCORD_GUILD_ID`
5. Stores the connection in KV
6. Redirects the browser to `WEBAPP_REDIRECT_URI`

**Do not call this from your backend** — it is a browser redirect target.

**Redirect on success**
```
{WEBAPP_REDIRECT_URI}?user_id=<id>&verified=true
{WEBAPP_REDIRECT_URI}?user_id=<id>&verified=false
```

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
| `guild_check_failed` | Could not check guild membership |

---

### `GET /users/:userId/discord`

**Protected.** Returns the stored Discord connection for a webapp user.

**Headers**
```
X-Api-Key: <API_SECRET>
```

**Success response — 200 (connected)**
```json
{
  "connected": true,
  "discord_id": "123456789012345678",
  "username": "zel",
  "avatar": "https://cdn.discordapp.com/avatars/123456789012345678/abc123.png",
  "verified": true,
  "connected_at": "2024-01-15T12:00:00.000Z"
}
```

`avatar` is `null` if the user has no Discord avatar.
`verified` is `false` if the user authenticated but is not in the configured guild.

**Response — 200 (not connected)**
```json
{ "connected": false }
```

**Error responses**

| Status | Body | Cause |
|--------|------|-------|
| 401 | `{ "error": "Unauthorized" }` | Missing or wrong `X-Api-Key` |

---

### `DELETE /users/:userId/discord`

**Protected.** Removes the stored Discord connection for a webapp user (disconnect).

**Headers**
```
X-Api-Key: <API_SECRET>
```

**Response — 200**
```json
{ "ok": true }
```

**Error responses**

| Status | Body | Cause |
|--------|------|-------|
| 401 | `{ "error": "Unauthorized" }` | Missing or wrong `X-Api-Key` |

---

## KV data shape

Discord connections are stored at key `discord:{webapp_user_id}`.

```json
{
  "discord_id": "string",
  "username": "string",
  "avatar": "string | null",
  "verified": "boolean",
  "connected_at": "ISO 8601 timestamp"
}
```

`verified` reflects guild membership at the time of connection. It does not update automatically — if you need live membership status, re-initiate the OAuth flow or add a separate check endpoint.

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
                                              ◄── { id, username, avatar }
                                GET /guilds/{guildId}/members/{discordId} ──► Discord
                                                                           ◄── member or 404
                                KV.put("discord:abc", { discord_id, verified, ... })
                                302 ──► WEBAPP_REDIRECT_URI?user_id=abc&verified=true

User's browser lands on webapp page
Webapp frontend reads query params, calls webapp backend

Webapp backend                  bettygo
─────────────                   ───────
GET /users/abc/discord ──►
                        ◄── { connected: true, verified: true, discord_id, username, avatar, connected_at }

Webapp backend sets user.discord_verified = true in its own DB
```

---

## Webapp integration walkthrough

Follow these steps to integrate bettygo into your webapp. All steps that say "webapp backend" mean server-side code making HTTP requests to bettygo. Never call protected endpoints from the browser.

### Step 1 — Initiate the Discord connect flow

When the user clicks "Connect Discord" (on the dashboard or during onboarding), your **webapp backend** calls:

```
GET https://<bettygo-url>/auth/login?user_id=<webapp_user_id>
X-Api-Key: <API_SECRET>
```

Parse the response and redirect the user's browser to the returned URL:

```json
{ "url": "https://discord.com/oauth2/authorize?..." }
```

Example (Node.js / fetch):
```js
const res = await fetch(`https://<bettygo-url>/auth/login?user_id=${user.id}`, {
  headers: { "X-Api-Key": process.env.BETTYGO_API_SECRET },
});
const { url } = await res.json();
// redirect user's browser to `url`
```

### Step 2 — Handle the callback redirect (frontend)

After Discord authorization, bettygo redirects the user's browser to `WEBAPP_REDIRECT_URI` with query params:

```
https://yourapp.com/discord-callback?user_id=abc&verified=true
https://yourapp.com/discord-callback?user_id=abc&verified=false
https://yourapp.com/discord-callback?error=oauth_denied
```

On your `/discord-callback` page:
- If `error` is present, show an error message and optionally let the user retry
- If `verified=true`, show success and notify the backend
- If `verified=false`, tell the user they need to join the guild first

### Step 3 — Confirm and store the result (webapp backend)

After the callback, your **webapp backend** calls bettygo to get the full connection data and update your own database:

```
GET https://<bettygo-url>/users/<webapp_user_id>/discord
X-Api-Key: <API_SECRET>
```

```json
{
  "connected": true,
  "discord_id": "123456789012345678",
  "username": "zel",
  "avatar": "https://cdn.discordapp.com/avatars/...",
  "verified": true,
  "connected_at": "2024-01-15T12:00:00.000Z"
}
```

Use this to update your user record: set `discord_verified = true`, store `discord_id`, etc.

### Step 4 — Disconnect Discord (optional)

To disconnect a user's Discord account:

```
DELETE https://<bettygo-url>/users/<webapp_user_id>/discord
X-Api-Key: <API_SECRET>
```

```json
{ "ok": true }
```

Then update your own DB accordingly.

---

## Setup

### 1. Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application
2. Under **OAuth2 → Redirects**, add: `https://<bettygo-url>/auth/callback`
3. Copy the **Client ID** and **Client Secret**
4. Under **Bot**, create a bot and copy the **Bot Token**
5. Invite the bot to your guild with the `bot` scope (no special permissions needed — it only reads member data)

### 2. Create a KV namespace

```bash
npx wrangler kv namespace create DISCORD_KV
```

Copy the returned `id` into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "DISCORD_KV", "id": "<your-namespace-id>" }
]
```

### 3. Configure vars in `wrangler.jsonc`

```jsonc
"vars": {
  "DISCORD_CLIENT_ID": "your_client_id",
  "DISCORD_GUILD_ID": "your_guild_id",
  "DISCORD_REDIRECT_URI": "https://<bettygo-url>/auth/callback",
  "WEBAPP_REDIRECT_URI": "https://yourapp.com/discord-callback",
  "ALLOWED_ORIGIN": "https://yourapp.com"
}
```

### 4. Set secrets

```bash
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put HMAC_SECRET    # any long random string
npx wrangler secret put API_SECRET     # share this with your webapp backend
```

### 5. Deploy

```bash
npm run dev      # local dev at http://localhost:8787
npm run deploy   # deploy to Cloudflare Workers
npm run test     # run tests with Vitest
```

---

## Security notes

- **CSRF protection**: the OAuth `state` is an HMAC-SHA256 token over `timestamp.userId`. It expires after 10 minutes and requires knowledge of `HMAC_SECRET` to forge — no KV or database needed for state storage.
- **API key**: protected endpoints require `X-Api-Key` matching `API_SECRET`. Keep this secret server-side only — never expose it to the browser.
- **Guild membership**: checked server-side using the bot token, so users cannot spoof membership by manipulating client-side state.
- **Secrets**: `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `HMAC_SECRET`, and `API_SECRET` are never exposed to the browser.
