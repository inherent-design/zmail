import { WorkOS } from "@workos-inc/node";
import type { Context } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { loadResolvedConfig } from "#/lib/app-config";
import { startTrace } from "#/lib/log";
import type { MachinePrincipal } from "#/server/auth";
import { assertWorkOsBootstrapEnv } from "#/server/auth";

let cachedMachineJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
export type MachineAuthFailure = "unauthenticated" | "forbidden";

function requireEnv(
	name: "WORKOS_API_KEY" | "WORKOS_M2M_CLIENT_ID" | "WORKOS_M2M_CLIENT_SECRET",
) {
	const value = process.env[name];
	if (!value || value.startsWith("REPLACE_ME_")) {
		throw new Error(`Missing required WorkOS bootstrap env: ${name}`);
	}
	return value;
}

function getWorkOS() {
	assertWorkOsBootstrapEnv();
	const workosConfig = loadResolvedConfig().auth.workos;
	return new WorkOS(requireEnv("WORKOS_API_KEY"), {
		clientId: requireEnv("WORKOS_M2M_CLIENT_ID"),
		...(workosConfig.apiHostname
			? { apiHostname: workosConfig.apiHostname }
			: {}),
		...(workosConfig.apiPort ? { port: workosConfig.apiPort } : {}),
		...(workosConfig.apiHttps !== undefined
			? { https: workosConfig.apiHttps }
			: {}),
	});
}

async function getMachineJwks() {
	if (cachedMachineJwks) {
		return cachedMachineJwks;
	}
	const workos = getWorkOS();
	cachedMachineJwks = createRemoteJWKSet(
		new URL(
			workos.userManagement.getJwksUrl(requireEnv("WORKOS_M2M_CLIENT_ID")),
		),
	);
	return cachedMachineJwks;
}

function machineTokenVerificationOptions() {
	const workos = getWorkOS();
	const audience = requireEnv("WORKOS_M2M_CLIENT_ID");
	const issuer = new URL(workos.userManagement.getJwksUrl(audience)).origin;
	return {
		issuer: [issuer, `${issuer}/`] as string[],
		audience,
	};
}

export function bearerTokenFromRequest(c: Context) {
	const authorization = c.req.header("authorization");
	if (!authorization?.startsWith("Bearer ")) {
		return null;
	}
	return authorization.slice("Bearer ".length).trim();
}

export async function authenticateMachineToken(
	token: string,
): Promise<MachinePrincipal | MachineAuthFailure> {
	const trace = startTrace({
		kind: "auth",
		operation: "workos.machine_token.authenticate",
	});
	try {
		const { payload } = await jwtVerify(
			token,
			await getMachineJwks(),
			machineTokenVerificationOptions(),
		);
		const sub = typeof payload.sub === "string" ? payload.sub : null;
		const orgId =
			typeof payload.org_id === "string"
				? payload.org_id
				: typeof payload.orgId === "string"
					? payload.orgId
					: null;
		if (!sub || !orgId) {
			trace.info("auth.machine_token.forbidden");
			return "forbidden";
		}
		trace.complete("auth.machine_token.authenticated", {
			org_id: orgId,
		});
		return {
			kind: "machine",
			sub,
			orgId,
			authMode: "workos_m2m",
		};
	} catch {
		trace.fail(
			"auth.machine_token.unauthenticated",
			new Error("Invalid token"),
		);
		return "unauthenticated";
	}
}
