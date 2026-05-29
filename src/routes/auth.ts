import { Hono } from "hono";
import { generateState, verifyState } from "../lib/state";
import { exchangeCode, getUser } from "../lib/discord";
import type { Env } from "../types";

const auth = new Hono<{ Bindings: Env }>();

function getAllowedRedirectUris(env: Env): string[] {
  return env.WEBAPP_REDIRECT_URI.split(",").map((u) => u.trim());
}

// GET /auth/login?user_id=<id>[&redirect_uri=<uri>]
// Protected — requires X-Api-Key header (enforced at app level).
// Returns the Discord OAuth2 authorization URL for the given webapp user.
// Optional redirect_uri must be one of the values in WEBAPP_REDIRECT_URI.
auth.get("/login", async (c) => {
  const userId = c.req.query("user_id");
  if (!userId) {
    return c.json({ error: "Missing user_id" }, 400);
  }

  const allowedRedirectUris = getAllowedRedirectUris(c.env);
  const requestedRedirectUri = c.req.query("redirect_uri");

  let redirectUri: string | undefined;
  if (requestedRedirectUri) {
    if (!allowedRedirectUris.includes(requestedRedirectUri)) {
      return c.json({ error: "Invalid redirect_uri" }, 400);
    }
    redirectUri = requestedRedirectUri;
  }

  const state = await generateState(c.env.HMAC_SECRET, userId, redirectUri);
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: c.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify guilds.members.read",
    state,
  });

  return c.json({ url: `https://discord.com/oauth2/authorize?${params}` });
});

// GET /auth/callback?code=<code>&state=<state>
// Public — called by Discord (user's browser redirect). Validates state,
// exchanges code, fetches the Discord user, then redirects to WEBAPP_REDIRECT_URI
// with ?user_id=<id>&discord_id=<discord_id>.
auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  const allowedRedirectUris = getAllowedRedirectUris(c.env);
  const defaultRedirectBase = allowedRedirectUris[0];

  const fail = (reason: string, redirectBase = defaultRedirectBase) =>
    c.redirect(`${redirectBase}?error=${encodeURIComponent(reason)}`);

  if (error) return fail("oauth_denied");
  if (!code || !state) return fail("missing_params");

  const payload = await verifyState(state, c.env.HMAC_SECRET);
  if (!payload) return fail("invalid_state");

  const { userId, redirectUri } = payload;
  const redirectBase = redirectUri ?? defaultRedirectBase;

  let accessToken: string;
  try {
    const token = await exchangeCode(
      code,
      c.env.DISCORD_CLIENT_ID,
      c.env.DISCORD_CLIENT_SECRET,
      c.env.DISCORD_REDIRECT_URI,
    );
    accessToken = token.access_token;
  } catch {
    return fail("token_exchange_failed", redirectBase);
  }

  let user: Awaited<ReturnType<typeof getUser>>;
  try {
    user = await getUser(accessToken);
  } catch {
    return fail("user_fetch_failed", redirectBase);
  }

  const params = new URLSearchParams({
    user_id: userId,
    discord_id: user.id,
    discord_username: user.username,
    discord_display_name: user.global_name ?? '',
    discord_avatar: user.avatar ?? '',
  });
  return c.redirect(`${redirectBase}?${params}`);
});

export default auth;
