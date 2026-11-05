import type {
  RESTGetAPICurrentUserResult,
  RESTGetAPIGuildMemberResult,
  RESTPostOAuth2AccessTokenResult,
} from "discord-api-types/v10";

const DISCORD_API = "https://discord.com/api/v10";

export type DiscordUser = RESTGetAPICurrentUserResult;
export type GuildMember = RESTGetAPIGuildMemberResult;
export type TokenResponse = RESTPostOAuth2AccessTokenResult;

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token_exchange_failed: ${res.status}`);
  return res.json() as Promise<TokenResponse>;
}

export async function getUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`user_fetch_failed: ${res.status}`);
  return res.json() as Promise<DiscordUser>;
}

export class DiscordAPIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function isGuildMember(
  userId: string,
  guildId: string,
  botToken: string,
): Promise<boolean> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new DiscordAPIError(`guild_check_failed: ${res.status}`, res.status);
  return true;
}

/** Discord snowflakes are decimal ids; anything else is a client bug, not a Discord call. */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{5,25}$/.test(value);
}

async function setRole(
  method: "PUT" | "DELETE",
  userId: string,
  guildId: string,
  roleId: string,
  botToken: string,
): Promise<void> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method,
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!res.ok) {
    const action = method === "PUT" ? "role_grant" : "role_revoke";
    throw new DiscordAPIError(`${action}_failed: ${res.status}`, res.status);
  }
}

/** Requires the bot to hold MANAGE_ROLES and to rank above the role it is assigning. */
export function grantRole(
  userId: string,
  guildId: string,
  roleId: string,
  botToken: string,
): Promise<void> {
  return setRole("PUT", userId, guildId, roleId, botToken);
}

export function revokeRole(
  userId: string,
  guildId: string,
  roleId: string,
  botToken: string,
): Promise<void> {
  return setRole("DELETE", userId, guildId, roleId, botToken);
}
