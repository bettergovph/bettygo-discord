export interface DiscordConnection {
  discord_id: string;
  username: string;
  avatar: string | null;
  verified: boolean;
  connected_at: string;
}

const key = (userId: string) => `discord:${userId}`;

export async function saveDiscordConnection(
  kv: KVNamespace,
  userId: string,
  data: DiscordConnection,
): Promise<void> {
  await kv.put(key(userId), JSON.stringify(data));
}

export async function getDiscordConnection(
  kv: KVNamespace,
  userId: string,
): Promise<DiscordConnection | null> {
  const raw = await kv.get(key(userId));
  if (!raw) return null;
  return JSON.parse(raw) as DiscordConnection;
}

export async function deleteDiscordConnection(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await kv.delete(key(userId));
}
