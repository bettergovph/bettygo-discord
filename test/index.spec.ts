import { createExecutionContext, env, fetchMock } from "cloudflare:test";
import worker from "../src/index";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateState, signResult, verifyState } from "../src/lib/state";

const API = "https://bettygo.test";
const DEFAULT_REDIRECT = "https://volunteers.bettergov.ph/discord-callback";
const LOCAL_REDIRECT = "http://localhost:3000/discord-callback";
const DISCORD = "https://discord.com";

const JSON_HEADERS = { "content-type": "application/json" };

function keyed(init: RequestInit = {}): RequestInit {
	return {
		...init,
		headers: { "X-Api-Key": env.API_SECRET, ...(init.headers as Record<string, string>) },
	};
}

function call(path: string, init?: RequestInit): Promise<Response> {
	return Promise.resolve(
		worker.fetch(new Request(`${API}${path}`, init), env, createExecutionContext()),
	);
}

async function hexSig(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function mockTokenExchange(accessToken = "access-token-123") {
	fetchMock
		.get(DISCORD)
		.intercept({ path: "/api/v10/oauth2/token", method: "POST" })
		.reply(
			200,
			{ access_token: accessToken, token_type: "Bearer", expires_in: 604800, scope: "identify" },
			{ headers: JSON_HEADERS },
		);
}

function mockUser(overrides: Record<string, unknown> = {}) {
	fetchMock
		.get(DISCORD)
		.intercept({ path: "/api/v10/users/@me" })
		.reply(
			200,
			{
				id: "123456789012345678",
				username: "bgvolunteer",
				global_name: "BG Volunteer",
				avatar: "abc123",
				discriminator: "0",
				...overrides,
			},
			{ headers: JSON_HEADERS },
		);
}

function mockMember(guildId: string, userId: string, status: number) {
	fetchMock
		.get(DISCORD)
		.intercept({ path: `/api/v10/guilds/${guildId}/members/${userId}` })
		.reply(status, status === 404 ? { message: "Unknown Member", code: 10007 } : { ok: status < 400 }, {
			headers: JSON_HEADERS,
		});
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe("GET /health", () => {
	it("returns ok without auth", async () => {
		const res = await call(`/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe("HMAC state", () => {
	it("round-trips a user id without a redirect", async () => {
		const state = await generateState(env.HMAC_SECRET, "web-user-1");
		const payload = await verifyState(state, env.HMAC_SECRET);
		expect(payload).toEqual({ userId: "web-user-1", redirectUri: null });
	});

	it("round-trips a user id with a redirect uri", async () => {
		const state = await generateState(env.HMAC_SECRET, "web-user-1", LOCAL_REDIRECT);
		const payload = await verifyState(state, env.HMAC_SECRET);
		expect(payload).toEqual({ userId: "web-user-1", redirectUri: LOCAL_REDIRECT });
	});

	it("rejects a tampered user id", async () => {
		const state = await generateState(env.HMAC_SECRET, "web-user-1");
		const parts = state.split(".");
		parts[1] = "web-user-2";
		expect(await verifyState(parts.join("."), env.HMAC_SECRET)).toBeNull();
	});

	it("rejects a state signed with another secret", async () => {
		const state = await generateState("other-secret", "web-user-1");
		expect(await verifyState(state, env.HMAC_SECRET)).toBeNull();
	});

	it("rejects an expired state", async () => {
		const ts = (Date.now() - 31 * 60 * 1000).toString();
		const payload = `${ts}.web-user-1`;
		const state = `${payload}.${await hexSig(env.HMAC_SECRET, payload)}`;
		expect(await verifyState(state, env.HMAC_SECRET)).toBeNull();
	});

	it("rejects a malformed state", async () => {
		expect(await verifyState("not-a-state", env.HMAC_SECRET)).toBeNull();
		expect(await verifyState("123.abc", env.HMAC_SECRET)).toBeNull();
	});
});

describe("GET /auth/login", () => {
	it("rejects requests without an api key", async () => {
		const res = await call(`/auth/login?user_id=web-user-1`);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Unauthorized" });
	});

	it("rejects requests without user_id", async () => {
		const res = await call(`/auth/login`, keyed());
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Missing user_id" });
	});

	it("rejects a redirect_uri outside the allowlist", async () => {
		const res = await call(
			`/auth/login?user_id=web-user-1&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`,
			keyed(),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid redirect_uri" });
	});

	it("returns a Discord authorize url carrying a verifiable state", async () => {
		const res = await call(
			`/auth/login?user_id=web-user-1&redirect_uri=${encodeURIComponent(LOCAL_REDIRECT)}`,
			keyed(),
		);
		expect(res.status).toBe(200);

		const { url } = (await res.json()) as { url: string };
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe("https://discord.com/oauth2/authorize");
		expect(parsed.searchParams.get("client_id")).toBe(env.DISCORD_CLIENT_ID);
		expect(parsed.searchParams.get("redirect_uri")).toBe(env.DISCORD_REDIRECT_URI);
		expect(parsed.searchParams.get("response_type")).toBe("code");
		expect(parsed.searchParams.get("scope")).toBe("identify guilds.members.read");

		const state = parsed.searchParams.get("state");
		expect(state).toBeTruthy();
		expect(await verifyState(state as string, env.HMAC_SECRET)).toEqual({
			userId: "web-user-1",
			redirectUri: LOCAL_REDIRECT,
		});
	});
});

describe("GET /auth/callback", () => {
	it("redirects with oauth_denied when Discord reports an error", async () => {
		const res = await call(`/auth/callback?error=access_denied`, { redirect: "manual" });
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location") as string);
		expect(location.origin + location.pathname).toBe(DEFAULT_REDIRECT);
		expect(location.searchParams.get("error")).toBe("oauth_denied");
	});

	it("redirects with missing_params when code or state is absent", async () => {
		const res = await call(`/auth/callback?code=abc`, { redirect: "manual" });
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location") as string);
		expect(location.searchParams.get("error")).toBe("missing_params");
	});

	it("redirects with invalid_state for a forged state", async () => {
		const res = await call(`/auth/callback?code=abc&state=forged.state.value`, {
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location") as string);
		expect(location.origin + location.pathname).toBe(DEFAULT_REDIRECT);
		expect(location.searchParams.get("error")).toBe("invalid_state");
	});

	it("redirects to the webapp with the Discord profile and a valid signature", async () => {
		mockTokenExchange();
		mockUser();

		const state = await generateState(env.HMAC_SECRET, "web-user-1", LOCAL_REDIRECT);
		const res = await call(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
			redirect: "manual",
		});
		expect(res.status).toBe(302);

		const location = new URL(res.headers.get("location") as string);
		expect(location.origin + location.pathname).toBe(LOCAL_REDIRECT);
		expect(location.searchParams.get("user_id")).toBe("web-user-1");
		expect(location.searchParams.get("discord_id")).toBe("123456789012345678");
		expect(location.searchParams.get("discord_username")).toBe("bgvolunteer");
		expect(location.searchParams.get("discord_display_name")).toBe("BG Volunteer");
		expect(location.searchParams.get("discord_avatar")).toBe("abc123");

		const ts = location.searchParams.get("ts") as string;
		const expected = await signResult(
			env.API_SECRET,
			`${ts}.web-user-1.123456789012345678.bgvolunteer`,
		);
		expect(location.searchParams.get("sig")).toBe(expected);
	});

	it("redirects with token_exchange_failed when Discord rejects the code", async () => {
		fetchMock
			.get(DISCORD)
			.intercept({ path: "/api/v10/oauth2/token", method: "POST" })
			.reply(400, { error: "invalid_grant" }, { headers: JSON_HEADERS });

		const state = await generateState(env.HMAC_SECRET, "web-user-1", LOCAL_REDIRECT);
		const res = await call(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
			redirect: "manual",
		});
		const location = new URL(res.headers.get("location") as string);
		expect(location.origin + location.pathname).toBe(LOCAL_REDIRECT);
		expect(location.searchParams.get("error")).toBe("token_exchange_failed");
	});

	it("redirects with user_fetch_failed when the profile call fails", async () => {
		mockTokenExchange();
		fetchMock
			.get(DISCORD)
			.intercept({ path: "/api/v10/users/@me" })
			.reply(500, { message: "boom" }, { headers: JSON_HEADERS });

		const state = await generateState(env.HMAC_SECRET, "web-user-1", LOCAL_REDIRECT);
		const res = await call(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
			redirect: "manual",
		});
		const location = new URL(res.headers.get("location") as string);
		expect(location.searchParams.get("error")).toBe("user_fetch_failed");
	});
});

describe("GET /users/:userId/discord", () => {
	const userId = "123456789012345678";

	it("rejects requests without an api key", async () => {
		const res = await call(`/users/${userId}/discord`);
		expect(res.status).toBe(401);
	});

	it("returns verified true for a guild member", async () => {
		mockMember(env.DISCORD_GUILD_ID, userId, 200);
		const res = await call(`/users/${userId}/discord`, keyed());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ verified: true });
	});

	it("returns verified false when Discord returns 404", async () => {
		mockMember(env.DISCORD_GUILD_ID, userId, 404);
		const res = await call(`/users/${userId}/discord`, keyed());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ verified: false });
	});

	it("returns 400 for a malformed Discord id", async () => {
		mockMember(env.DISCORD_GUILD_ID, "not-a-snowflake", 400);
		const res = await call(`/users/not-a-snowflake/discord`, keyed());
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_discord_id" });
	});

	it("returns 500 when the bot token is rejected", async () => {
		mockMember(env.DISCORD_GUILD_ID, userId, 401);
		const res = await call(`/users/${userId}/discord`, keyed());
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "bot_auth_failed" });
	});

	it("returns 502 for unexpected Discord failures", async () => {
		mockMember(env.DISCORD_GUILD_ID, userId, 500);
		const res = await call(`/users/${userId}/discord`, keyed());
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "guild_check_failed" });
	});
});
