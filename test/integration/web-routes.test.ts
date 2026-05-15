import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#/test/helpers/runtime";

async function loadApiApp(input?: {
	basePath?: string;
	role?: "org_admin" | "org_operator" | "org_viewer";
}) {
	const runtime = await createTestRuntime();
	process.env.NODE_ENV = "test";
	process.env.ZMAIL_TEST_AUTH_BYPASS = "true";
	process.env.ZMAIL_TEST_AUTH_ORG_ID = "local";
	process.env.ZMAIL_TEST_AUTH_ROLE = input?.role ?? "org_admin";
	if (input?.basePath) {
		process.env.ZMAIL_BASE_PATH = input.basePath;
	} else {
		delete process.env.ZMAIL_BASE_PATH;
	}
	vi.resetModules();
	const { app } =
		await runtime.importFresh<typeof import("#/server/app")>("#/server/app");
	return { app, runtime };
}

describe("Hono API routes", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("keeps health and readiness on Hono", async () => {
		const { app } = await loadApiApp();

		const health = await app.request("http://localhost/healthz");
		expect(health.status).toBe(200);
		await expect(health.json()).resolves.toMatchObject({
			ok: true,
			status: "ok",
			service: "zmail",
		});

		const ready = await app.request("http://localhost/readyz");
		expect(ready.status).toBe(200);
		await expect(ready.json()).resolves.toMatchObject({
			ok: true,
			status: "ready",
			base_path: "/",
		});
	});

	it("does not serve removed SSE route", async () => {
		const { app } = await loadApiApp();

		const response = await app.request("http://localhost/events");

		expect(response.status).toBe(404);
	});

	it("keeps bearer tokens out of browser WebSocket auth", async () => {
		const { app } = await loadApiApp();

		const response = await app.request("http://localhost/ws", {
			headers: { authorization: "Bearer test-token" },
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: "machine_tokens_not_allowed",
		});
	});

	it("honors base path for Hono-owned API routes", async () => {
		const { app } = await loadApiApp({ basePath: "/zmail" });

		const scoped = await app.request("http://localhost/zmail/rpc/noop", {
			method: "POST",
		});
		const unscoped = await app.request("http://localhost/rpc/noop", {
			method: "POST",
		});

		expect(scoped.status).toBe(202);
		expect(unscoped.status).toBe(404);
	});
});
