export interface Env {
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  DISCORD_REDIRECT_URI: string;
  WEBAPP_REDIRECT_URI: string;
  HMAC_SECRET: string;
  API_SECRET: string;
  ALLOWED_ORIGIN: string;
  DISCORD_KV: KVNamespace;
}
