import { beforeEach, describe, expect, it, vi } from "vitest";

describe("app config", () => {
	beforeEach(() => {
		vi.resetModules();
		delete process.env.ZMAIL_PUBLIC_ORIGIN;
		delete process.env.ZMAIL_BASE_PATH;
		delete process.env.ZMAIL_BIND_HOST;
		delete process.env.ZMAIL_BIND_PORT;
		delete process.env.PORT;
		delete process.env.ZMAIL_RUN_WORKER;
		delete process.env.RUN_WORKER;
		delete process.env.ZMAIL_METRICS_ENABLED;
		delete process.env.ZMAIL_METRICS_PATH;
		delete process.env.ZMAIL_LOG_FILE;
		delete process.env.ZMAIL_OTLP_ENABLED;
		delete process.env.ZMAIL_OTLP_ENDPOINT;
		delete process.env.ZMAIL_SERVICE_INSTANCE_ID;
		delete process.env.WORKOS_REDIRECT_URI;
		delete process.env.GOOGLE_OAUTH_REDIRECT_URL;
	});

	it("loads the checked-in local defaults from zmail.toml", async () => {
		const config = await import("#/lib/app-config");
		expect(config.loadResolvedConfig()).toMatchObject({
			server: {
				bindHost: "127.0.0.1",
				bindPort: 56711,
				publicOrigin: "http://127.0.0.1:56711",
				basePath: "/",
			},
			auth: {
				workos: {
					bootstrapAdminEmails: ["mannie@inherent.design"],
				},
			},
			observability: {
				metricsEnabled: false,
				metricsPath: "/metrics",
				logFile: null,
				otlpEnabled: false,
				otlpEndpoint: null,
			},
		});
		expect(config.workosRedirectUri()).toBe(
			"http://127.0.0.1:56711/auth/callback",
		);
		expect(config.googleOAuthRedirectUrl()).toBe(
			"http://127.0.0.1:56711/oauth/google/callback",
		);
	});

	it("normalizes configured bootstrap admin emails", async () => {
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => true),
				readFileSync: vi.fn(
					() => `
[auth.workos]
bootstrap_admin_emails = [" Mannie@Inherent.Design ", "mannie@inherent.design", "OTHER@EXAMPLE.COM"]
`,
				),
			};
		});

		try {
			const config = await import("#/lib/app-config");
			expect(
				config.loadResolvedConfig().auth.workos.bootstrapAdminEmails,
			).toEqual(["mannie@inherent.design", "other@example.com"]);
		} finally {
			vi.doUnmock("node:fs");
		}
	});

	it("defaults bootstrap admin emails to an empty list when unset", async () => {
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => true),
				readFileSync: vi.fn(
					() => `
[auth.workos]
api_https = true
`,
				),
			};
		});

		try {
			const config = await import("#/lib/app-config");
			expect(
				config.loadResolvedConfig().auth.workos.bootstrapAdminEmails,
			).toEqual([]);
		} finally {
			vi.doUnmock("node:fs");
		}
	});

	it("derives callbacks and route prefixes from public origin and base path", async () => {
		process.env.ZMAIL_PUBLIC_ORIGIN = "https://zmail.inherent.design";
		process.env.ZMAIL_BASE_PATH = "/zmail";
		const config = await import("#/lib/app-config");
		expect(config.appPath("/accounts")).toBe("/zmail/accounts");
		expect(config.assetPath("/client/app.js")).toBe("/zmail/client/app.js");
		expect(config.stripBasePath("/zmail/messages/123")).toBe("/messages/123");
		expect(config.workosRedirectUri()).toBe(
			"https://zmail.inherent.design/zmail/auth/callback",
		);
		expect(config.googleOAuthRedirectUrl()).toBe(
			"https://zmail.inherent.design/zmail/oauth/google/callback",
		);
	});

	it("lets explicit callback env override the derived defaults", async () => {
		process.env.WORKOS_REDIRECT_URI = "http://localhost:56711/auth/callback";
		process.env.GOOGLE_OAUTH_REDIRECT_URL =
			"http://localhost:56711/oauth/google/callback";
		const config = await import("#/lib/app-config");
		expect(config.workosRedirectUri()).toBe(
			"http://localhost:56711/auth/callback",
		);
		expect(config.googleOAuthRedirectUrl()).toBe(
			"http://localhost:56711/oauth/google/callback",
		);
	});

	it("derives alternate local callbacks from ZMAIL_PUBLIC_ORIGIN", async () => {
		process.env.ZMAIL_PUBLIC_ORIGIN = "http://localhost:56711";
		const config = await import("#/lib/app-config");
		expect(config.workosRedirectUri()).toBe(
			"http://localhost:56711/auth/callback",
		);
		expect(config.googleOAuthRedirectUrl()).toBe(
			"http://localhost:56711/oauth/google/callback",
		);
	});

	it("derives the hosted callbacks from ZMAIL_PUBLIC_ORIGIN", async () => {
		process.env.ZMAIL_PUBLIC_ORIGIN = "https://zmail.inherent.design";
		const config = await import("#/lib/app-config");
		expect(config.workosRedirectUri()).toBe(
			"https://zmail.inherent.design/auth/callback",
		);
		expect(config.googleOAuthRedirectUrl()).toBe(
			"https://zmail.inherent.design/oauth/google/callback",
		);
	});

	it("ignores placeholder callback overrides and falls back to derived defaults", async () => {
		process.env.ZMAIL_PUBLIC_ORIGIN = "http://localhost:56711";
		process.env.WORKOS_REDIRECT_URI = "REPLACE_ME_WORKOS_REDIRECT_URI";
		process.env.GOOGLE_OAUTH_REDIRECT_URL =
			"REPLACE_ME_GOOGLE_OAUTH_REDIRECT_URL";
		const config = await import("#/lib/app-config");
		expect(config.workosRedirectUri()).toBe(
			"http://localhost:56711/auth/callback",
		);
		expect(config.googleOAuthRedirectUrl()).toBe(
			"http://localhost:56711/oauth/google/callback",
		);
	});

	it("supports legacy PORT and RUN_WORKER fallbacks for one migration pass", async () => {
		process.env.PORT = "4100";
		process.env.RUN_WORKER = "false";
		const config = await import("#/lib/app-config");
		expect(config.loadResolvedConfig()).toMatchObject({
			server: {
				bindPort: 4100,
			},
			worker: {
				enabled: false,
			},
		});
	});

	it("rejects invalid base paths", async () => {
		process.env.ZMAIL_BASE_PATH = "zmail";
		const config = await import("#/lib/app-config");
		expect(() => config.loadResolvedConfig()).toThrow(/base_path/i);
	});

	it("lets observability env override TOML", async () => {
		process.env.ZMAIL_METRICS_ENABLED = "true";
		process.env.ZMAIL_METRICS_PATH = "/internal-metrics";
		process.env.ZMAIL_LOG_FILE = ".observability/logs/zmail.ndjson";
		process.env.ZMAIL_OTLP_ENABLED = "true";
		process.env.ZMAIL_OTLP_ENDPOINT = "http://127.0.0.1:4318";
		process.env.ZMAIL_SERVICE_INSTANCE_ID = "test-instance";
		const config = await import("#/lib/app-config");
		expect(config.loadResolvedConfig().observability).toMatchObject({
			metricsEnabled: true,
			metricsPath: "/internal-metrics",
			logFile: ".observability/logs/zmail.ndjson",
			otlpEnabled: true,
			otlpEndpoint: "http://127.0.0.1:4318",
			serviceInstanceId: "test-instance",
		});
	});

	it("rejects invalid observability values", async () => {
		process.env.ZMAIL_METRICS_PATH = "metrics";
		let config = await import("#/lib/app-config");
		expect(() => config.loadResolvedConfig()).toThrow(/metrics_path/i);

		vi.resetModules();
		delete process.env.ZMAIL_METRICS_PATH;
		process.env.ZMAIL_LOG_FILE = "public/zmail.ndjson";
		config = await import("#/lib/app-config");
		expect(() => config.loadResolvedConfig()).toThrow(/log_file/i);

		vi.resetModules();
		delete process.env.ZMAIL_LOG_FILE;
		process.env.ZMAIL_OTLP_ENDPOINT = "not-a-url";
		config = await import("#/lib/app-config");
		expect(() => config.loadResolvedConfig()).toThrow(/Invalid URL/i);
	});
});
