import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						DISCORD_CLIENT_SECRET: "test-client-secret",
						DISCORD_BOT_TOKEN: "test-bot-token",
						HMAC_SECRET: "test-hmac-secret",
						API_SECRET: "test-api-secret",
					},
				},
			},
		},
	},
});
