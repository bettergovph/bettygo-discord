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

// State format: {timestamp}.{userId}.{hmac(timestamp.userId)}
export async function generateState(secret: string, userId: string): Promise<string> {
  const ts = Date.now().toString();
  const payload = `${ts}.${userId}`;
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${bufToHex(sig)}`;
}

// Returns the userId encoded in the state, or null if invalid/expired.
export async function verifyState(state: string, secret: string): Promise<string | null> {
  const parts = state.split(".");
  if (parts.length < 3) return null;

  const sig = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join(".");
  const ts = parts[0];

  const age = Date.now() - parseInt(ts, 10);
  if (isNaN(age) || age < 0 || age > STATE_TTL_MS) return null;

  const key = await importKey(secret);
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));

  if (sig !== bufToHex(expected)) return null;

  // userId is everything between ts and the trailing sig
  return parts.slice(1, -1).join(".");
}
