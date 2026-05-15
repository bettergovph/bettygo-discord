import { Hono } from "hono";
import { generateState, verifyState } from "../lib/state";
import { buildAvatarUrl, exchangeCode, getUser, isGuildMember } from "../lib/discord";
import { saveDiscordConnection } from "../lib/kv";
import type { Env } from "../types";

const auth = new Hono<{ Bindings: Env }>();

// GET /auth/login?user_id=<id>
// Protected — requires X-Api-Key header (enforced at app level).
// Returns the Discord OAuth2 authorization URL for the given webapp user.
auth.get("/login", async (c) => {
  const userId = c.req.query("user_id");
  if (!userId) {
    return c.json({ error: "Missing user_id" }, 400);
  }

  const state = await generateState(c.env.HMAC_SECRET, userId);
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
// exchanges code, checks guild membership, stores result in KV, then
// redirects the browser back to WEBAPP_REDIRECT_URI.
auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  const redirectBase = c.env.WEBAPP_REDIRECT_URI;

  const fail = (reason: string) =>
    c.redirect(`${redirectBase}?error=${encodeURIComponent(reason)}`);

  if (error) return fail("oauth_denied");
  if (!code || !state) return fail("missing_params");

  const userId = await verifyState(state, c.env.HMAC_SECRET);
  if (!userId) return fail("invalid_state");

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
    return fail("token_exchange_failed");
  }

  let user: Awaited<ReturnType<typeof getUser>>;
  try {
    user = await getUser(accessToken);
  } catch {
    return fail("user_fetch_failed");
  }

  let verified: boolean;
  try {
    verified = await isGuildMember(user.id, c.env.DISCORD_GUILD_ID, c.env.DISCORD_BOT_TOKEN);
  } catch {
    return fail("guild_check_failed");
  }

  await saveDiscordConnection(c.env.DISCORD_KV, userId, {
    discord_id: user.id,
    username: user.username,
    avatar: buildAvatarUrl(user),
    verified,
    connected_at: new Date().toISOString(),
  });

  const params = new URLSearchParams({
    user_id: userId,
    verified: String(verified),
  });
  return c.redirect(`${redirectBase}?${params}`);
});

export default auth;
