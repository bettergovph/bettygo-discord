import { Hono } from "hono";
import { getDiscordConnection, deleteDiscordConnection } from "../lib/kv";
import type { Env } from "../types";

const users = new Hono<{ Bindings: Env }>();

users.get("/:userId/discord", async (c) => {
  const { userId } = c.req.param();
  const connection = await getDiscordConnection(c.env.DISCORD_KV, userId);

  if (!connection) {
    return c.json({ connected: false });
  }

  return c.json({ connected: true, ...connection });
});

users.delete("/:userId/discord", async (c) => {
  const { userId } = c.req.param();
  await deleteDiscordConnection(c.env.DISCORD_KV, userId);
  return c.json({ ok: true });
});

export default users;
