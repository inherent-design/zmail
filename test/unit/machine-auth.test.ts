import { beforeEach, describe, expect, it, vi } from "vitest";

describe("machine auth", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.NODE_ENV = "test";
		process.env.WORKOS_API_KEY = "workos_api_key";
		process.env.WORKOS_CLIENT_ID = "workos_client_id";
		process.env.WORKOS_COOKIE_PASSWORD =
			"workos_cookie_password_minimum_length_value";
		process.env.WORKOS_M2M_CLIENT_ID = "workos_m2m_client_id";
		process.env.WORKOS_M2M_CLIENT_SECRET = "workos_m2m_client_secret";
	});

	it("authenticates valid machine tokens with issuer and audience checks", async () => {
		const jwtVerify = vi.fn(async () => ({
			payload: {
				sub: "client_123",
				org_id: "org-1",
			},
		}));
		const createRemoteJWKSet = vi.fn((url: URL) => {
			expect(url.toString()).toBe(
				"https://api.workos.com/sso/jwks/workos_m2m_client_id",
			);
			return "jwks";
		});
		const getJwksUrl = vi.fn(
			(clientId: string) => `https://api.workos.com/sso/jwks/${clientId}`,
		);

		vi.doMock("jose", () => ({
			createRemoteJWKSet,
			jwtVerify,
		}));
		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					getJwksUrl,
				},
			})),
		}));

		try {
			const machineAuth = await import("#/server/machine-auth");
			await expect(
				machineAuth.authenticateMachineToken("machine-token"),
			).resolves.toMatchObject({
				kind: "machine",
				sub: "client_123",
				orgId: "org-1",
				authMode: "workos_m2m",
			});
			expect(getJwksUrl).toHaveBeenCalledWith("workos_m2m_client_id");
			expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
			expect(jwtVerify).toHaveBeenCalledWith("machine-token", "jwks", {
				issuer: ["https://api.workos.com", "https://api.workos.com/"],
				audience: "workos_m2m_client_id",
			});
		} finally {
			vi.doUnmock("jose");
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("returns forbidden when a verified machine token has no org claim", async () => {
		const jwtVerify = vi.fn(async () => ({
			payload: {
				sub: "client_123",
			},
		}));
		const createRemoteJWKSet = vi.fn(() => "jwks");

		vi.doMock("jose", () => ({
			createRemoteJWKSet,
			jwtVerify,
		}));
		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					getJwksUrl: () =>
						"https://api.workos.com/sso/jwks/workos_m2m_client_id",
				},
			})),
		}));

		try {
			const machineAuth = await import("#/server/machine-auth");
			await expect(
				machineAuth.authenticateMachineToken("machine-token"),
			).resolves.toBe("forbidden");
		} finally {
			vi.doUnmock("jose");
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("returns unauthenticated when issuer validation fails", async () => {
		const jwtVerify = vi.fn(async () => {
			throw new Error("unexpected issuer");
		});
		const createRemoteJWKSet = vi.fn(() => "jwks");

		vi.doMock("jose", () => ({
			createRemoteJWKSet,
			jwtVerify,
		}));
		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					getJwksUrl: () =>
						"https://api.workos.com/sso/jwks/workos_m2m_client_id",
				},
			})),
		}));

		try {
			const machineAuth = await import("#/server/machine-auth");
			await expect(
				machineAuth.authenticateMachineToken("wrong-issuer-token"),
			).resolves.toBe("unauthenticated");
			expect(jwtVerify).toHaveBeenCalledWith("wrong-issuer-token", "jwks", {
				issuer: ["https://api.workos.com", "https://api.workos.com/"],
				audience: "workos_m2m_client_id",
			});
		} finally {
			vi.doUnmock("jose");
			vi.doUnmock("@workos-inc/node");
		}
	});

	it("returns unauthenticated when audience validation fails", async () => {
		const jwtVerify = vi.fn(async () => {
			throw new Error("unexpected audience");
		});
		const createRemoteJWKSet = vi.fn(() => "jwks");

		vi.doMock("jose", () => ({
			createRemoteJWKSet,
			jwtVerify,
		}));
		vi.doMock("@workos-inc/node", () => ({
			WorkOS: vi.fn().mockImplementation(() => ({
				userManagement: {
					getJwksUrl: () =>
						"https://api.workos.com/sso/jwks/workos_m2m_client_id",
				},
			})),
		}));

		try {
			const machineAuth = await import("#/server/machine-auth");
			await expect(
				machineAuth.authenticateMachineToken("wrong-audience-token"),
			).resolves.toBe("unauthenticated");
			expect(jwtVerify).toHaveBeenCalledWith("wrong-audience-token", "jwks", {
				issuer: ["https://api.workos.com", "https://api.workos.com/"],
				audience: "workos_m2m_client_id",
			});
		} finally {
			vi.doUnmock("jose");
			vi.doUnmock("@workos-inc/node");
		}
	});
});
