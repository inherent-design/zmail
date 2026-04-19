import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#/test/helpers/runtime";

const ENVIRONMENT_ROLE_DEFS = [
	{
		slug: "org_admin",
		name: "Org Admin",
		description: "Full operator access within the organization.",
	},
	{
		slug: "org_operator",
		name: "Org Operator",
		description: "Routine operator actions within the organization.",
	},
	{
		slug: "org_viewer",
		name: "Org Viewer",
		description: "Read-only access within the organization.",
	},
] as const;

describe("server auth bootstrap", () => {
	beforeEach(() => {
		vi.resetModules();
		delete process.env.WORKOS_API_KEY;
		delete process.env.WORKOS_CLIENT_ID;
		delete process.env.WORKOS_COOKIE_PASSWORD;
		delete process.env.WORKOS_REDIRECT_URI;
		delete process.env.WORKOS_M2M_CLIENT_ID;
		delete process.env.WORKOS_M2M_CLIENT_SECRET;
		delete process.env.ZMAIL_TEST_AUTH_BYPASS;
		process.env.NODE_ENV = "test";
	});

	it("rejects placeholder browser bootstrap env when the test bypass is disabled", async () => {
		process.env.WORKOS_API_KEY = "REPLACE_ME_WORKOS_API_KEY";
		process.env.WORKOS_CLIENT_ID = "REPLACE_ME_WORKOS_CLIENT_ID";
		process.env.WORKOS_COOKIE_PASSWORD =
			"REPLACE_ME_WORKOS_COOKIE_PASSWORD_MIN_32_CHARS";

		const auth = await import("#/server/auth");
		expect(() => auth.assertWorkOsBootstrapEnv()).toThrow(
			/Missing required WorkOS bootstrap env/,
		);
	});

	it("does not require WorkOS M2M bootstrap for browser startup", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const auth = await import("#/server/auth");
		expect(() => auth.assertWorkOsBootstrapEnv()).not.toThrow();
	});

	it("allows the explicit test-only auth bypass", async () => {
		process.env.ZMAIL_TEST_AUTH_BYPASS = "true";
		const auth = await import("#/server/auth");
		expect(() => auth.assertWorkOsBootstrapEnv()).not.toThrow();
	});

	it("rejects traversal-like WorkOS callback state without touching files outside auth state storage", async () => {
		const runtime = await createTestRuntime();
		const auth =
			await runtime.importFresh<typeof import("#/server/auth")>(
				"#/server/auth",
			);
		const { Hono } = await import("hono");
		const app = new Hono();
		app.get("/", auth.handleAuthCallback);
		const victimPath = resolve(runtime.root, "victim.json");
		writeFileSync(
			victimPath,
			JSON.stringify({
				state: "victim",
				codeVerifier: "secret",
				returnTo: "/private",
			}),
			"utf8",
		);

		const response = await app.request(
			"http://localhost/?code=code&state=../../../../victim",
		);

		expect(response.status).toBe(400);
		expect(existsSync(victimPath)).toBe(true);
		expect(JSON.parse(readFileSync(victimPath, "utf8"))).toMatchObject({
			state: "victim",
			returnTo: "/private",
		});
	});

	it("stores only internal return targets during WorkOS login", async () => {
		const runtime = await createTestRuntime();
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";
		const getAuthorizationUrlWithPKCE = vi.fn(async () => ({
			url: "https://auth.workos.test/login",
			state: "safe_state-123",
			codeVerifier: "code-verifier",
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					getAuthorizationUrlWithPKCE,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth =
				await runtime.importFresh<typeof import("#/server/auth")>(
					"#/server/auth",
				);
			const app = new Hono();
			app.get("/", auth.handleLogin);

			const response = await app.request(
				"http://localhost/?returnTo=https://evil.test/phish",
			);

			const statePath = resolve(
				runtime.dataDir,
				"tmp",
				"oauth",
				"workos",
				"safe_state-123.json",
			);
			expect(response.headers.get("location")).toBe(
				"https://auth.workos.test/login",
			);
			expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
				state: "safe_state-123",
				codeVerifier: "code-verifier",
				returnTo: "/",
			});
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("falls back to app root when stored WorkOS return target is external", async () => {
		const runtime = await createTestRuntime();
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";
		const authenticateWithCode = vi.fn(async () => ({
			sealedSession: "sealed-session-value",
			organizationId: "org-1",
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					authenticateWithCode,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth =
				await runtime.importFresh<typeof import("#/server/auth")>(
					"#/server/auth",
				);
			const statePath = resolve(
				runtime.dataDir,
				"tmp",
				"oauth",
				"workos",
				"safe_state-123.json",
			);
			mkdirSync(resolve(runtime.dataDir, "tmp", "oauth", "workos"), {
				recursive: true,
			});
			writeFileSync(
				statePath,
				JSON.stringify({
					state: "safe_state-123",
					codeVerifier: "code-verifier",
					returnTo: "https://evil.test/phish",
				}),
				"utf8",
			);
			const app = new Hono();
			app.get("/", auth.handleAuthCallback);

			const response = await app.request(
				"http://localhost/?code=code&state=safe_state-123",
			);

			expect(authenticateWithCode).toHaveBeenCalledWith(
				expect.objectContaining({
					code: "code",
					codeVerifier: "code-verifier",
				}),
			);
			expect(response.headers.get("location")).toBe("/");
			expect(response.headers.get("set-cookie")).toContain(
				"zmail_session=sealed-session-value",
			);
			expect(existsSync(statePath)).toBe(false);
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("promotes configured bootstrap admins to org_admin during org-bound refresh", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const listEnvironmentRoles = vi.fn(async () => ({ data: [] }));
		const createEnvironmentRole = vi.fn(async () => undefined);
		const updateOrganizationMembership = vi.fn(async () => undefined);
		const refresh = vi.fn(async () => ({
			authenticated: true,
			sealedSession: "sealed-session-admin",
			organizationId: "org-1",
			role: "org_admin",
			permissions: ["*"],
		}));
		const loadSealedSession = vi.fn(() => ({
			refresh,
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				authorization: {
					listEnvironmentRoles,
					createEnvironmentRole,
				},
				userManagement: {
					updateOrganizationMembership,
					loadSealedSession,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			let principal:
				| Awaited<ReturnType<typeof auth.ensureBootstrapAdminPrincipal>>
				| undefined;
			const app = new Hono();
			app.get("/", async (c) => {
				principal = await auth.ensureBootstrapAdminPrincipal(
					c,
					{
						kind: "browser",
						sub: "user-1",
						email: "mannie@inherent.design",
						orgId: "org-1",
						role: "org_viewer",
						permissions: [],
						authMode: "workos",
					},
					[
						{
							id: "membership-1",
							organizationId: "org-1",
							organizationName: "Inherent",
							role: "org_viewer",
						},
					],
				);
				return c.text("ok");
			});

			const response = await app.request("http://localhost/", {
				headers: {
					cookie: "zmail_session=sealed-session-viewer",
				},
			});

			expect(updateOrganizationMembership).toHaveBeenCalledWith(
				"membership-1",
				{ roleSlug: "org_admin" },
			);
			expect(listEnvironmentRoles).toHaveBeenCalledTimes(1);
			expect(createEnvironmentRole.mock.calls).toEqual(
				ENVIRONMENT_ROLE_DEFS.map((role) => [role]),
			);
			expect(loadSealedSession).toHaveBeenCalledWith({
				sessionData: "sealed-session-viewer",
				cookiePassword: "workos_cookie_password_minimum_length_value",
			});
			expect(refresh).toHaveBeenCalledWith({
				organizationId: "org-1",
				cookiePassword: "workos_cookie_password_minimum_length_value",
			});
			expect(principal).toMatchObject({
				email: "mannie@inherent.design",
				orgId: "org-1",
				role: "org_admin",
			});
			expect(response.headers.get("set-cookie")).toContain(
				"zmail_session=sealed-session-admin",
			);
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("seeds environment roles before creating an org admin membership", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const createOrganization = vi.fn(async () => ({ id: "org-1" }));
		const listEnvironmentRoles = vi.fn(async () => ({ data: [] }));
		const createEnvironmentRole = vi.fn(async () => undefined);
		const createOrganizationMembership = vi.fn(async () => undefined);
		const refresh = vi.fn(async () => ({
			authenticated: true,
			sealedSession: "sealed-session-admin",
			organizationId: "org-1",
			role: "org_admin",
			permissions: ["*"],
		}));
		const loadSealedSession = vi.fn(() => ({
			refresh,
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				authorization: {
					listEnvironmentRoles,
					createEnvironmentRole,
				},
				organizations: {
					createOrganization,
				},
				userManagement: {
					createOrganizationMembership,
					loadSealedSession,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			const app = new Hono();
			app.post("/", async (c) => {
				c.set("principal", {
					kind: "browser",
					sub: "user-1",
					email: "mannie@inherent.design",
					orgId: null,
					role: null,
					permissions: [],
					authMode: "workos",
				});
				return auth.createOrganizationForBrowserSession(c, "Inherent");
			});

			const response = await app.request(
				"http://localhost/?returnTo=https://evil.test/phish",
				{
					method: "POST",
					headers: {
						cookie: "zmail_session=sealed-session-viewer",
					},
				},
			);

			expect(createOrganization).toHaveBeenCalledWith({
				name: "Inherent",
			});
			expect(listEnvironmentRoles).toHaveBeenCalledTimes(1);
			expect(createEnvironmentRole.mock.calls).toEqual(
				ENVIRONMENT_ROLE_DEFS.map((role) => [role]),
			);
			expect(createOrganizationMembership).toHaveBeenCalledWith({
				organizationId: "org-1",
				userId: "user-1",
				roleSlug: "org_admin",
			});
			expect(response.headers.get("location")).toBe("/");
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("does not create environment roles when zmail roles already exist", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const listEnvironmentRoles = vi.fn(async () => ({
			data: ENVIRONMENT_ROLE_DEFS,
		}));
		const createEnvironmentRole = vi.fn(async () => undefined);
		const updateOrganizationMembership = vi.fn(async () => undefined);
		const refresh = vi.fn(async () => ({
			authenticated: true,
			sealedSession: "sealed-session-admin",
			organizationId: "org-1",
			role: "org_admin",
			permissions: ["*"],
		}));
		const loadSealedSession = vi.fn(() => ({
			refresh,
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				authorization: {
					listEnvironmentRoles,
					createEnvironmentRole,
				},
				userManagement: {
					updateOrganizationMembership,
					loadSealedSession,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			const app = new Hono();
			app.get("/", async (c) => {
				await auth.ensureBootstrapAdminPrincipal(
					c,
					{
						kind: "browser",
						sub: "user-1",
						email: "mannie@inherent.design",
						orgId: "org-1",
						role: "org_viewer",
						permissions: [],
						authMode: "workos",
					},
					[
						{
							id: "membership-1",
							organizationId: "org-1",
							organizationName: "Inherent",
							role: "org_viewer",
						},
					],
				);
				return c.text("ok");
			});

			await app.request("http://localhost/", {
				headers: {
					cookie: "zmail_session=sealed-session-viewer",
				},
			});

			expect(listEnvironmentRoles).toHaveBeenCalledTimes(1);
			expect(createEnvironmentRole).not.toHaveBeenCalled();
			expect(updateOrganizationMembership).toHaveBeenCalledWith(
				"membership-1",
				{ roleSlug: "org_admin" },
			);
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("falls back to app root when org selection return target is external", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const listOrganizationMemberships = vi.fn(async () => ({
			autoPagination: async () => [
				{
					id: "membership-1",
					organizationId: "org-1",
					organizationName: "Inherent",
					role: { slug: "org_viewer" },
				},
			],
		}));
		const refresh = vi.fn(async () => ({
			authenticated: true,
			sealedSession: "sealed-session-viewer",
			organizationId: "org-1",
			role: "org_viewer",
			permissions: [],
		}));
		const loadSealedSession = vi.fn(() => ({
			refresh,
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					listOrganizationMemberships,
					loadSealedSession,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			const app = new Hono();
			app.post("/", async (c) => {
				c.set("principal", {
					kind: "browser",
					sub: "user-1",
					email: "viewer@inherent.design",
					orgId: null,
					role: null,
					permissions: [],
					authMode: "workos",
				});
				return auth.selectOrganizationForBrowserSession(c, "org-1");
			});

			const response = await app.request(
				"http://localhost/?returnTo=https://evil.test/phish",
				{
					method: "POST",
					headers: {
						cookie: "zmail_session=sealed-session-viewer",
					},
				},
			);

			expect(response.headers.get("location")).toBe("/");
			expect(refresh).toHaveBeenCalledWith({
				organizationId: "org-1",
				cookiePassword: "workos_cookie_password_minimum_length_value",
			});
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("treats WorkOS member roles as org_viewer", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const authenticateWithSessionCookie = vi.fn(async () => ({
			authenticated: true,
			user: {
				id: "user-1",
				email: "viewer@inherent.design",
			},
			organizationId: "org-1",
			role: "member",
			permissions: [],
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					authenticateWithSessionCookie,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			const app = new Hono();
			app.use("*", auth.browserSessionMiddleware);
			app.get("/", (c) => c.json(c.get("principal")));

			const response = await app.request("http://localhost/", {
				headers: {
					cookie: "zmail_session=sealed-session-viewer",
				},
			});

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				kind: "browser",
				orgId: "org-1",
				role: "org_viewer",
			});
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("prefers the highest zmail role from WorkOS roles arrays", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const authenticateWithSessionCookie = vi.fn(async () => ({
			authenticated: true,
			user: {
				id: "user-1",
				email: "operator@inherent.design",
			},
			organizationId: "org-1",
			role: "org_viewer",
			roles: ["org_operator", "org_viewer"],
			permissions: ["mail:view"],
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					authenticateWithSessionCookie,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			const app = new Hono();
			app.use("*", auth.browserSessionMiddleware);
			app.get("/", (c) => c.json(c.get("principal")));

			const response = await app.request("http://localhost/", {
				headers: {
					cookie: "zmail_session=sealed-session-operator",
				},
			});

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				kind: "browser",
				orgId: "org-1",
				role: "org_operator",
				permissions: ["mail:view"],
			});
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("uses WorkOS logout URLs when a valid browser session is present", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const authenticate = vi.fn(async () => ({
			authenticated: true,
			sessionId: "session-1",
		}));
		const loadSealedSession = vi.fn(() => ({
			authenticate,
		}));
		const getLogoutUrl = vi.fn(
			({ sessionId, returnTo }: { sessionId: string; returnTo?: string }) =>
				`https://api.workos.com/user_management/sessions/logout?session_id=${sessionId}&return_to=${encodeURIComponent(returnTo ?? "")}`,
		);

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					loadSealedSession,
					getLogoutUrl,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			const app = new Hono();
			app.post("/", auth.handleLogout);

			const response = await app.request("http://localhost/", {
				method: "POST",
				headers: {
					cookie: "zmail_session=sealed-session-value",
				},
			});

			expect(loadSealedSession).toHaveBeenCalledWith({
				sessionData: "sealed-session-value",
				cookiePassword: "workos_cookie_password_minimum_length_value",
			});
			expect(authenticate).toHaveBeenCalledTimes(1);
			expect(getLogoutUrl).toHaveBeenCalledWith({
				sessionId: "session-1",
				returnTo: "http://127.0.0.1:56711/",
			});
			expect(response.headers.get("location")).toBe(
				"https://api.workos.com/user_management/sessions/logout?session_id=session-1&return_to=http%3A%2F%2F127.0.0.1%3A56711%2F",
			);
			expect(response.headers.get("set-cookie")).toContain("zmail_session=");
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("falls back to the app root on logout when the session cookie is invalid", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const authenticate = vi.fn(async () => ({
			authenticated: false,
			reason: "invalid_session_cookie",
		}));
		const loadSealedSession = vi.fn(() => ({
			authenticate,
		}));
		const getLogoutUrl = vi.fn();

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					loadSealedSession,
					getLogoutUrl,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			const app = new Hono();
			app.post("/", auth.handleLogout);

			const response = await app.request("http://localhost/", {
				method: "POST",
				headers: {
					cookie: "zmail_session=sealed-session-value",
				},
			});

			expect(response.headers.get("location")).toBe("/");
			expect(getLogoutUrl).not.toHaveBeenCalled();
			expect(response.headers.get("set-cookie")).toContain("zmail_session=");
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("maps refreshed WorkOS roles arrays during browser org activation", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const authenticateWithSessionCookie = vi.fn(async () => ({
			authenticated: true,
			user: {
				id: "user-1",
				email: "viewer@inherent.design",
			},
			permissions: [],
		}));
		const listOrganizationMemberships = vi.fn(async () => ({
			autoPagination: async () => [
				{
					id: "membership-1",
					organizationId: "org-1",
					organizationName: "Inherent",
					role: { slug: "member" },
				},
			],
		}));
		const refresh = vi.fn(async () => ({
			authenticated: true,
			sealedSession: "sealed-session-operator",
			organizationId: "org-1",
			roles: ["org_operator", "org_viewer"],
			permissions: ["mail:view"],
		}));
		const loadSealedSession = vi.fn(() => ({
			refresh,
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					authenticateWithSessionCookie,
					listOrganizationMemberships,
					loadSealedSession,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			const app = new Hono();
			app.use("*", auth.browserSessionMiddleware);
			app.use("*", auth.activeBrowserOrgMiddleware);
			app.get("/", (c) => c.json(c.get("principal")));

			const response = await app.request("http://localhost/", {
				headers: {
					cookie: "zmail_session=sealed-session-viewer",
				},
			});

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				kind: "browser",
				orgId: "org-1",
				role: "org_operator",
				permissions: ["mail:view"],
			});
			expect(refresh).toHaveBeenCalledWith({
				organizationId: "org-1",
				cookiePassword: "workos_cookie_password_minimum_length_value",
			});
			expect(response.headers.get("set-cookie")).toContain(
				"zmail_session=sealed-session-operator",
			);
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("tolerates duplicate environment-role races during bootstrap promotion", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const listEnvironmentRoles = vi
			.fn()
			.mockResolvedValueOnce({ data: [] })
			.mockResolvedValueOnce({ data: ENVIRONMENT_ROLE_DEFS });
		const createEnvironmentRole = vi.fn(async () => {
			throw new Error("duplicate role");
		});
		const updateOrganizationMembership = vi.fn(async () => undefined);
		const refresh = vi.fn(async () => ({
			authenticated: true,
			sealedSession: "sealed-session-admin",
			organizationId: "org-1",
			role: "org_admin",
			permissions: ["*"],
		}));
		const loadSealedSession = vi.fn(() => ({
			refresh,
		}));

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				authorization: {
					listEnvironmentRoles,
					createEnvironmentRole,
				},
				userManagement: {
					updateOrganizationMembership,
					loadSealedSession,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			const app = new Hono();
			app.get("/", async (c) => {
				await auth.ensureBootstrapAdminPrincipal(
					c,
					{
						kind: "browser",
						sub: "user-1",
						email: "mannie@inherent.design",
						orgId: "org-1",
						role: "org_viewer",
						permissions: [],
						authMode: "workos",
					},
					[
						{
							id: "membership-1",
							organizationId: "org-1",
							organizationName: "Inherent",
							role: "org_viewer",
						},
					],
				);
				return c.text("ok");
			});

			const response = await app.request("http://localhost/", {
				headers: {
					cookie: "zmail_session=sealed-session-viewer",
				},
			});

			expect(response.status).toBe(200);
			expect(listEnvironmentRoles).toHaveBeenCalledTimes(2);
			expect(createEnvironmentRole).toHaveBeenCalledTimes(1);
			expect(updateOrganizationMembership).toHaveBeenCalledWith(
				"membership-1",
				{ roleSlug: "org_admin" },
			);
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("does not promote non-listed users during org-bound refresh", async () => {
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";

		const updateOrganizationMembership = vi.fn(async () => undefined);
		const loadSealedSession = vi.fn();

		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					updateOrganizationMembership,
					loadSealedSession,
				},
			})),
		}));

		try {
			const { Hono } = await import("hono");
			const auth = await import("#/server/auth");
			let principal:
				| Awaited<ReturnType<typeof auth.ensureBootstrapAdminPrincipal>>
				| undefined;
			const app = new Hono();
			app.get("/", async (c) => {
				principal = await auth.ensureBootstrapAdminPrincipal(
					c,
					{
						kind: "browser",
						sub: "user-2",
						email: "michael@inherent.design",
						orgId: "org-1",
						role: "org_viewer",
						permissions: [],
						authMode: "workos",
					},
					[
						{
							id: "membership-2",
							organizationId: "org-1",
							organizationName: "Inherent",
							role: "org_viewer",
						},
					],
				);
				return c.text("ok");
			});

			const response = await app.request("http://localhost/", {
				headers: {
					cookie: "zmail_session=sealed-session-viewer",
				},
			});

			expect(principal).toMatchObject({
				email: "michael@inherent.design",
				orgId: "org-1",
				role: "org_viewer",
			});
			expect(updateOrganizationMembership).not.toHaveBeenCalled();
			expect(loadSealedSession).not.toHaveBeenCalled();
			expect(response.headers.get("set-cookie")).toBeNull();
		} finally {
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("serves unauthenticated health endpoints", async () => {
		process.env.ZMAIL_TEST_AUTH_BYPASS = "true";

		const { app } = await import("#/server/index");

		const healthResponse = await app.request("/healthz");
		expect(healthResponse.status).toBe(200);
		expect(await healthResponse.json()).toMatchObject({
			ok: true,
			status: "ok",
		});

		const readyResponse = await app.request("/readyz");
		expect(readyResponse.status).toBe(200);
		expect(await readyResponse.json()).toMatchObject({
			ok: true,
			status: "ready",
			worker_enabled: true,
			metrics_enabled: false,
		});
	});
});
