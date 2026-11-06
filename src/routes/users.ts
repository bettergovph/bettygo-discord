import { Hono } from "hono";
import { getGuildMembership, isSnowflake, grantRole, revokeRole, DiscordAPIError } from "../lib/discord";
import type { Env } from "../types";

const users = new Hono<{ Bindings: Env }>();

// GET /users/:userId/discord
// Protected — requires X-Api-Key header (enforced at app level).
// :userId must be the Discord user snowflake ID.
// Returns { verified: boolean, roles: string[] } from a live guild membership check.
// `roles` lets the caller diff the roles it manages instead of guessing.
users.get("/:userId/discord", async (c) => {
  const { userId } = c.req.param();
  let membership: { verified: boolean; roles: string[] };
  try {
    membership = await getGuildMembership(userId, c.env.DISCORD_GUILD_ID, c.env.DISCORD_BOT_TOKEN);
  } catch (err) {
    if (err instanceof DiscordAPIError) {
      if (err.status === 400) return c.json({ error: "invalid_discord_id" }, 400);
      if (err.status === 401 || err.status === 403) return c.json({ error: "bot_auth_failed" }, 500);
    }
    return c.json({ error: "guild_check_failed" }, 502);
  }
  return c.json({ verified: membership.verified, roles: membership.roles });
});

// POST /users/:userId/discord/roles  { roleId }
// Assigns a guild role to a member. Needs the bot to hold MANAGE_ROLES and to rank above roleId.
users.post("/:userId/discord/roles", async (c) => {
  const { userId } = c.req.param();
  if (!isSnowflake(userId)) return c.json({ error: "invalid_discord_id" }, 400);

  let body: { roleId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const roleId = body?.roleId;
  if (!isSnowflake(roleId)) return c.json({ error: "invalid_role_id" }, 400);

  try {
    await grantRole(userId, c.env.DISCORD_GUILD_ID, roleId, c.env.DISCORD_BOT_TOKEN);
  } catch (err) {
    return roleError(c, err, "role_grant_failed");
  }
  return c.json({ granted: true, roleId });
});

// DELETE /users/:userId/discord/roles/:roleId
// Takes a role back. Same permissions as granting.
users.delete("/:userId/discord/roles/:roleId", async (c) => {
  const { userId, roleId } = c.req.param();
  if (!isSnowflake(userId)) return c.json({ error: "invalid_discord_id" }, 400);
  if (!isSnowflake(roleId)) return c.json({ error: "invalid_role_id" }, 400);

  try {
    await revokeRole(userId, c.env.DISCORD_GUILD_ID, roleId, c.env.DISCORD_BOT_TOKEN);
  } catch (err) {
    return roleError(c, err, "role_revoke_failed");
  }
  return c.json({ revoked: true, roleId });
});

export default users;

/** Maps Discord's answers onto the same error vocabulary the membership check uses. */
function roleError(c: any, err: unknown, fallback: string) {
  if (err instanceof DiscordAPIError) {
    if (err.status === 400) return c.json({ error: "invalid_request" }, 400);
    if (err.status === 401) return c.json({ error: "bot_auth_failed" }, 500);
    if (err.status === 403) return c.json({ error: "bot_permission_denied" }, 500);
    if (err.status === 404) return c.json({ error: "unknown_member_or_role" }, 404);
  }
  return c.json({ error: fallback }, 502);
}
