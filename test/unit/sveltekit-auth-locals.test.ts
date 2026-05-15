import { describe, expect, it } from "vitest";

import { resolveBrowserPrincipalFromRequest } from "#/server/auth";

describe("SvelteKit auth locals bridge", () => {
	it("resolves test browser principal from request-neutral helper", async () => {
		process.env.NODE_ENV = "test";
		process.env.ZMAIL_TEST_AUTH_BYPASS = "true";
		process.env.ZMAIL_TEST_AUTH_ORG_ID = "local";
		process.env.ZMAIL_TEST_AUTH_ROLE = "org_admin";

		const resolved = await resolveBrowserPrincipalFromRequest(
			new Request("http://localhost/finance"),
		);

		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.principal.orgId).toBe("local");
			expect(resolved.principal.role).toBe("org_admin");
		}
	});

	it("rejects bearer tokens for browser helpers", async () => {
		const resolved = await resolveBrowserPrincipalFromRequest(
			new Request("http://localhost/ws", {
				headers: { authorization: "Bearer token" },
			}),
		);

		expect(resolved).toEqual({
			ok: false,
			status: 401,
			error: "machine_tokens_not_allowed",
		});
	});
});
