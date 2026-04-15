import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createMockLogModule } from "#/test/helpers/log";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("google-oauth", () => {
	it("isOAuthConfigured returns false when env vars are empty", async () => {
		await createTestRuntime();
		const mod = await import("#/lib/google-oauth");
		expect(mod.isOAuthConfigured()).toBe(false);
	});

	it("missingOAuthVars returns both var names when unset", async () => {
		await createTestRuntime();
		const mod = await import("#/lib/google-oauth");
		expect(mod.missingOAuthVars()).toEqual([
			"GOOGLE_OAUTH_CLIENT_ID",
			"GOOGLE_OAUTH_CLIENT_SECRET",
		]);
	});

	it("isOAuthConfigured returns true when env vars are set", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		expect(mod.isOAuthConfigured()).toBe(true);
		expect(mod.missingOAuthVars()).toEqual([]);
	});

	it("buildAuthUrl generates URL with correct params and writes state file", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		const { url, state } = mod.buildAuthUrl("Work Gmail");
		expect(state).toBeTruthy();
		expect(url).toContain("accounts.google.com");
		expect(url).toContain("client_id=cid");
		expect(url).toContain("response_type=code");
		expect(url).toContain("access_type=offline");
		expect(url).toContain("code_challenge_method=S256");

		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		const stateFile = `${config.OAUTH_TMP_DIR}/${state}.json`;
		expect(existsSync(stateFile)).toBe(true);
		const contents = JSON.parse(readFileSync(stateFile, "utf8"));
		expect(contents).toMatchObject({
			state,
			label: "Work Gmail",
			flow: "connect",
		});
		expect(contents.codeVerifier).toBeTruthy();
	});

	it("buildAuthUrl stores reconnect flow metadata when provided", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		const { state } = mod.buildAuthUrl({
			label: "Reconnect Gmail",
			flow: "reconnect",
			accountId: "acct-1",
		});
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		const contents = JSON.parse(
			readFileSync(`${config.OAUTH_TMP_DIR}/${state}.json`, "utf8"),
		);

		expect(contents).toMatchObject({
			state,
			label: "Reconnect Gmail",
			flow: "reconnect",
			accountId: "acct-1",
		});
	});

	it("loadOAuthState reads and deletes state file, returns null for missing", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);

		expect(mod.loadOAuthState("nonexistent")).toBeNull();

		const { state } = mod.buildAuthUrl("Test");
		const loaded = mod.loadOAuthState(state);
		expect(loaded).toMatchObject({
			state,
			label: "Test",
			flow: "connect",
		});
		expect(loaded?.codeVerifier).toBeTruthy();

		expect(mod.loadOAuthState(state)).toBeNull();
	});

	it("loadOAuthState rejects traversal-like state values without touching files outside oauth temp storage", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);

		const victimPath = resolve(runtime.root, "victim.json");
		writeFileSync(
			victimPath,
			JSON.stringify({
				state: "victim",
				codeVerifier: "secret",
				label: "Victim",
			}),
			"utf8",
		);

		expect(mod.loadOAuthState("../../../../victim")).toBeNull();
		expect(existsSync(victimPath)).toBe(true);
		expect(JSON.parse(readFileSync(victimPath, "utf8"))).toMatchObject({
			state: "victim",
			label: "Victim",
		});
	});

	it("writeOAuthToken / readOAuthToken / deleteOAuthToken roundtrip", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);

		const record = {
			version: 1 as const,
			provider: "google" as const,
			emailAddress: "test@example.com",
			accessToken: "access-tok",
			refreshToken: "refresh-tok",
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			scope: ["openid", "email"],
			tokenType: "Bearer",
			updatedAt: new Date().toISOString(),
		};

		mod.writeOAuthToken("acct-1", record);
		const read = mod.readOAuthToken("acct-1");
		expect(read).toMatchObject({
			version: 1,
			provider: "google",
			emailAddress: "test@example.com",
			accessToken: "access-tok",
			refreshToken: "refresh-tok",
		});

		mod.deleteOAuthToken("acct-1");
		expect(mod.readOAuthToken("acct-1")).toBeNull();
	});

	it("readOAuthToken returns null for non-existent account", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		expect(mod.readOAuthToken("does-not-exist")).toBeNull();
	});

	it("readOAuthToken returns null for invalid token JSON", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		const brokenPath = config.accountOAuthPath("broken");
		mkdirSync(dirname(brokenPath), { recursive: true });
		writeFileSync(brokenPath, "{not-json", "utf8");

		expect(mod.readOAuthToken("broken")).toBeNull();
	});

	it("deleteOAuthToken is safe for non-existent account", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		expect(() => mod.deleteOAuthToken("does-not-exist")).not.toThrow();
	});

	it("buildOAuthRecord constructs correct shape", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);

		const tokens = {
			access_token: "at",
			refresh_token: "rt",
			expires_in: 3600,
			token_type: "Bearer",
			scope: "openid email",
		};

		const record = mod.buildOAuthRecord("user@gmail.com", tokens);
		expect(record).toMatchObject({
			version: 1,
			provider: "google",
			emailAddress: "user@gmail.com",
			accessToken: "at",
			refreshToken: "rt",
			tokenType: "Bearer",
			scope: ["openid", "email"],
		});
		expect(record.expiresAt).toBeTruthy();
		expect(record.updatedAt).toBeTruthy();
	});

	it("exchangeCode calls fetch with correct params", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
		vi.resetModules();

		const mockResponse = {
			ok: true,
			json: async () => ({
				access_token: "new-at",
				refresh_token: "new-rt",
				expires_in: 3600,
				token_type: "Bearer",
				scope: "openid email",
			}),
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(mockResponse as Response);

		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		const result = await mod.exchangeCode("auth-code", "verifier");

		expect(result.access_token).toBe("new-at");
		expect(result.refresh_token).toBe("new-rt");
		expect(fetchSpy).toHaveBeenCalledOnce();
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toContain("oauth2.googleapis.com/token");
		expect(init?.method).toBe("POST");
		const body = (init?.body as URLSearchParams).toString();
		expect(body).toContain("code=auth-code");
		expect(body).toContain("code_verifier=verifier");
	});

	it("exchangeCode throws on non-ok response", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 400,
			text: async () => "bad request",
		} as Response);

		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		await expect(mod.exchangeCode("bad", "bad")).rejects.toThrow(
			"Token exchange failed",
		);
	});

	it("refreshAccessToken calls fetch with correct params", async () => {
		const runtime = await createTestRuntime();
		process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
		process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
		vi.resetModules();

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "refreshed-at",
				expires_in: 3600,
				token_type: "Bearer",
				scope: "openid email",
			}),
		} as Response);

		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		const result = await mod.refreshAccessToken("my-refresh-token");

		expect(result.access_token).toBe("refreshed-at");
		const body = (
			fetchSpy.mock.calls[0][1]?.body as URLSearchParams
		).toString();
		expect(body).toContain("refresh_token=my-refresh-token");
		expect(body).toContain("grant_type=refresh_token");
	});

	it("refreshAccessToken throws on non-ok response", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => "unauthorized",
		} as Response);

		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		await expect(mod.refreshAccessToken("bad-token")).rejects.toThrow(
			"Token refresh failed",
		);
	});

	it("fetchEmailIdentity returns email on success", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({ email: "user@gmail.com" }),
		} as Response);

		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		const email = await mod.fetchEmailIdentity("valid-token");
		expect(email).toBe("user@gmail.com");
	});

	it("fetchEmailIdentity throws on non-ok response", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 403,
		} as Response);

		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);
		await expect(mod.fetchEmailIdentity("bad-token")).rejects.toThrow(
			"Userinfo fetch failed",
		);
	});

	it("ensureFreshToken returns token when not expired", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);

		const record = {
			version: 1 as const,
			provider: "google" as const,
			emailAddress: "test@example.com",
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
			scope: ["openid"],
			tokenType: "Bearer",
			updatedAt: new Date().toISOString(),
		};
		mod.writeOAuthToken("acct-fresh", record);

		const result = await mod.ensureFreshToken("acct-fresh");
		expect(result).toMatchObject({ accessToken: "at" });
	});

	it("ensureFreshToken refreshes expired token", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "new-at",
				expires_in: 3600,
				token_type: "Bearer",
				scope: "openid",
			}),
		} as Response);

		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);

		const record = {
			version: 1 as const,
			provider: "google" as const,
			emailAddress: "test@example.com",
			accessToken: "old-at",
			refreshToken: "rt",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
			scope: ["openid"],
			tokenType: "Bearer",
			updatedAt: new Date().toISOString(),
		};
		mod.writeOAuthToken("acct-exp", record);

		const result = await mod.ensureFreshToken("acct-exp");
		expect(result?.accessToken).toBe("new-at");
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "complete",
					event: "oauth.refresh.complete",
				}),
			]),
		);
	});

	it("ensureFreshToken returns null when no token exists", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);
		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);

		const result = await mod.ensureFreshToken("no-such-acct");
		expect(result).toBeNull();
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "info",
					event: "oauth.token_missing",
				}),
			]),
		);
	});

	it("ensureFreshToken returns null when refresh fails", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();
		const log = createMockLogModule();
		vi.doMock("#/lib/log", () => log.module);

		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => "bad",
		} as Response);

		const mod =
			await runtime.importFresh<typeof import("#/lib/google-oauth")>(
				"#/lib/google-oauth",
			);

		const record = {
			version: 1 as const,
			provider: "google" as const,
			emailAddress: "test@example.com",
			accessToken: "old",
			refreshToken: "bad-rt",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
			scope: ["openid"],
			tokenType: "Bearer",
			updatedAt: new Date().toISOString(),
		};
		mod.writeOAuthToken("acct-fail", record);

		const result = await mod.ensureFreshToken("acct-fail");
		expect(result).toBeNull();
		expect(log.records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "fail",
					event: "oauth.refresh.failed",
				}),
			]),
		);
	});
});
