const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function importKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64Url(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

// State format (no redirect):  {ts}.{userId}.{hmac}
// State format (with redirect): {ts}.{userId}.{base64url(redirectUri)}.{hmac}
// base64url contains only [A-Za-z0-9_-], so dots remain safe delimiters.
export async function generateState(
  secret: string,
  userId: string,
  redirectUri?: string,
): Promise<string> {
  const ts = Date.now().toString();
  const payload = redirectUri
    ? `${ts}.${userId}.${toBase64Url(redirectUri)}`
    : `${ts}.${userId}`;
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${bufToHex(sig)}`;
}

export interface StatePayload {
  userId: string;
  redirectUri: string | null;
}

// Returns the decoded payload, or null if invalid/expired.
export async function verifyState(
  state: string,
  secret: string,
): Promise<StatePayload | null> {
  const parts = state.split(".");
  // Minimum 3 parts: ts, userId, hmac
  if (parts.length < 3) return null;

  const sig = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join(".");
  const ts = parts[0];

  const age = Date.now() - parseInt(ts, 10);
  if (isNaN(age) || age < 0 || age > STATE_TTL_MS) return null;

  const key = await importKey(secret);
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  if (sig !== bufToHex(expected)) return null;

  const userId = parts[1];
  const redirectUri = parts.length === 4 ? fromBase64Url(parts[2]) : null;

  return { userId, redirectUri };
}

// Signs the OAuth result handed back to the webapp so it can't be edited in the URL.
// Payload: {ts}.{userId}.{discordId}.{discordUsername}, keyed with the shared API secret
// the webapp already holds (it sends it as X-Api-Key). Returns lowercase hex.
export async function signResult(secret: string, payload: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bufToHex(sig);
}
