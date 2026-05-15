import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { WorkOS } from "@workos-inc/node";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
	appPath,
	appUrl,
	loadResolvedConfig,
	stripBasePath,
	workosRedirectUri,
} from "#/lib/app-config";
import { OAUTH_TMP_DIR } from "#/lib/config";
import { startTrace } from "#/lib/log";
import {
	claimLegacyRuntime,
	currentOrgId,
	defaultOrgId,
	orgNeedsLegacyClaim,
	runWithOrgContext,
} from "#/lib/runtime";

export type OrgRole = "org_admin" | "org_operator" | "org_viewer";

export interface BrowserPrincipal {
	kind: "browser";
	sub: string;
	email: string;
	orgId: string | null;
	role: OrgRole | null;
	permissions: string[];
	authMode: "workos";
}

export interface MachinePrincipal {
	kind: "machine";
	sub: string;
	orgId: string;
	authMode: "workos_m2m";
}

export type SessionPrincipal = BrowserPrincipal | MachinePrincipal;

const SESSION_COOKIE = "zmail_session";
const WORKOS_STATE_DIR = resolve(OAUTH_TMP_DIR, "..", "workos");
const WORKOS_STATE_TOKEN_RE = /^[A-Za-z0-9_-]{8,256}$/;
const ORG_ROLE_ORDER: Record<OrgRole, number> = {
	org_viewer: 0,
	org_operator: 1,
	org_admin: 2,
};
const WORKOS_ROLE_CONFIGURATION_MESSAGE =
	"zmail could not ensure required WorkOS environment roles. Check WorkOS Authorization setup or API connectivity.";
const REQUIRED_BROWSER_BOOTSTRAP_ENV = [
	"WORKOS_API_KEY",
	"WORKOS_CLIENT_ID",
	"WORKOS_COOKIE_PASSWORD",
] as const;
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

declare module "hono" {
	interface ContextVariableMap {
		principal: SessionPrincipal;
		orgId: string;
	}
}

interface WorkOsState {
	state: string;
	codeVerifier: string;
	returnTo: string;
}

interface BrowserMembership {
	id: string;
	organizationId: string;
	organizationName: string;
	role: OrgRole;
}

export class WorkOsRoleConfigurationError extends Error {
	constructor(cause?: unknown) {
		super(
			WORKOS_ROLE_CONFIGURATION_MESSAGE,
			cause instanceof Error ? { cause } : undefined,
		);
		this.name = "WorkOsRoleConfigurationError";
	}
}

function requireEnv(
	name: (typeof REQUIRED_BROWSER_BOOTSTRAP_ENV)[number],
): string {
	const value = process.env[name];
	if (!value || value.startsWith("REPLACE_ME_")) {
		throw new Error(
			`Missing required WorkOS bootstrap env: ${name}. Run the server through mise so secrets.enc.yaml is loaded, or provide the variable through deployment runtime env.`,
		);
	}
	return value;
}

export function testAuthBypassEnabled() {
	return (
		process.env.NODE_ENV === "test" &&
		process.env.ZMAIL_TEST_AUTH_BYPASS === "true"
	);
}

export function assertWorkOsBootstrapEnv() {
	if (testAuthBypassEnabled()) {
		return;
	}
	for (const name of REQUIRED_BROWSER_BOOTSTRAP_ENV) {
		requireEnv(name);
	}
}

function cookieOptions(c: Context) {
	return {
		httpOnly: true,
		path: "/",
		sameSite: "Lax" as const,
		secure: isSecureSessionRequest(c),
	};
}

function isSecureSessionRequest(c: Context) {
	if (loadResolvedConfig().server.publicOrigin.startsWith("https://")) {
		return true;
	}
	if (c.req.url.startsWith("https://")) {
		return true;
	}
	const forwardedProto = c.req
		.header("x-forwarded-proto")
		?.split(",")[0]
		?.trim()
		.toLowerCase();
	if (forwardedProto === "https") {
		return true;
	}
	return /(^|[;,]\s*)proto=https($|[;,])/i.test(
		c.req.header("forwarded") ?? "",
	);
}

function getWorkOS() {
	assertWorkOsBootstrapEnv();
	const workosConfig = loadResolvedConfig().auth.workos;
	return new WorkOS(requireEnv("WORKOS_API_KEY"), {
		clientId: requireEnv("WORKOS_CLIENT_ID"),
		...(workosConfig.apiHostname
			? { apiHostname: workosConfig.apiHostname }
			: {}),
		...(workosConfig.apiPort ? { port: workosConfig.apiPort } : {}),
		...(workosConfig.apiHttps !== undefined
			? { https: workosConfig.apiHttps }
			: {}),
	});
}

function workosRole(role: string | null | undefined): OrgRole {
	switch (role) {
		case "org_admin":
		case "org_operator":
		case "org_viewer":
			return role;
		default:
			return "org_viewer";
	}
}

function workosRoleFromSlugs(
	role: string | null | undefined,
	roles?: readonly (string | null | undefined)[] | null,
): OrgRole {
	let resolvedRole = workosRole(role);
	for (const candidateRole of roles ?? []) {
		const normalizedRole = workosRole(candidateRole);
		if (ORG_ROLE_ORDER[normalizedRole] > ORG_ROLE_ORDER[resolvedRole]) {
			resolvedRole = normalizedRole;
		}
	}
	return resolvedRole;
}

function workosRoleFromResponses(
	role: { slug: string } | null | undefined,
	roles?: readonly { slug: string }[] | null,
): OrgRole {
	return workosRoleFromSlugs(
		role?.slug,
		roles?.map((candidateRole) => candidateRole.slug),
	);
}

export function normalizeBrowserPrincipalEmail(email: string) {
	return email.trim().toLowerCase();
}

function isBootstrapAdminEmail(email: string) {
	return loadResolvedConfig().auth.workos.bootstrapAdminEmails.includes(
		normalizeBrowserPrincipalEmail(email),
	);
}

function wantsStructuredAuthFailure(c: Context) {
	const pathname = stripBasePath(new URL(c.req.url).pathname);
	return (
		pathname.startsWith("/rpc/") ||
		pathname.startsWith("/api/") ||
		pathname === "/ws" ||
		c.req.header("x-requested-with") === "zmail-client" ||
		c.req.header("x-requested-with") === "zmail-nav" ||
		c.req.header("x-requested-with") === "zmail-prefetch" ||
		c.req.header("x-requested-with") === "zmail-stress" ||
		c.req.header("accept")?.includes("application/json") === true
	);
}

function structuredFailure(
	c: Context,
	status: 401 | 409,
	error: string,
	location?: string,
) {
	if (wantsStructuredAuthFailure(c)) {
		return c.json(
			{
				ok: false,
				error,
				...(location ? { location } : {}),
			},
			{ status },
		);
	}
	if (location) {
		return c.redirect(location);
	}
	return c.html(`<h1>${error}</h1>`, { status });
}

function redirectToLogin(c: Context) {
	return structuredFailure(
		c,
		401,
		"unauthenticated",
		appPath(
			`/auth/login?returnTo=${encodeURIComponent(currentRequestPath(c))}`,
		),
	);
}

function currentRequestPath(c: Context) {
	const url = new URL(c.req.url);
	return `${url.pathname}${url.search}`;
}

function orgRoutePath(pathname: string, c: Context) {
	return appPath(
		`${pathname}?returnTo=${encodeURIComponent(currentRequestPath(c))}`,
	);
}

export function safeReturnTo(input: string | null | undefined) {
	const fallback = appPath("/");
	const raw = input?.trim();
	if (
		!raw ||
		!raw.startsWith("/") ||
		raw.startsWith("//") ||
		raw.includes("\\") ||
		containsControlCharacter(raw)
	) {
		return fallback;
	}
	const { basePath } = loadResolvedConfig().server;
	if (basePath !== "/" && raw !== basePath && !raw.startsWith(`${basePath}/`)) {
		return fallback;
	}
	return raw;
}

function containsControlCharacter(value: string) {
	for (let index = 0; index < value.length; index += 1) {
		const charCode = value.charCodeAt(index);
		if (charCode < 32 || charCode === 127) {
			return true;
		}
	}
	return false;
}

function redirectToOrgSelect(c: Context) {
	return structuredFailure(
		c,
		409,
		"org_selection_required",
		orgRoutePath("/org/select", c),
	);
}

function redirectToOrgCreate(c: Context) {
	return structuredFailure(
		c,
		409,
		"org_creation_required",
		orgRoutePath("/org/create", c),
	);
}

function redirectToLegacyClaim(c: Context) {
	return structuredFailure(
		c,
		409,
		"legacy_claim_required",
		orgRoutePath("/org/claim-legacy", c),
	);
}

function writeWorkOsState(state: WorkOsState) {
	if (!WORKOS_STATE_TOKEN_RE.test(state.state)) {
		throw new Error("Invalid WorkOS login state token.");
	}
	mkdirSync(WORKOS_STATE_DIR, { recursive: true });
	writeFileSync(
		resolve(WORKOS_STATE_DIR, `${state.state}.json`),
		JSON.stringify(state),
		"utf8",
	);
}

function readWorkOsState(state: string) {
	if (!WORKOS_STATE_TOKEN_RE.test(state)) {
		return null;
	}
	try {
		const path = resolve(WORKOS_STATE_DIR, `${state}.json`);
		const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkOsState;
		unlinkSync(path);
		return parsed;
	} catch {
		return null;
	}
}

function testBrowserPrincipal(): BrowserPrincipal {
	return {
		kind: "browser",
		sub: process.env.ZMAIL_TEST_AUTH_SUB ?? "test-user",
		email: process.env.ZMAIL_TEST_AUTH_EMAIL ?? "test@zmail.dev",
		orgId: process.env.ZMAIL_TEST_AUTH_ORG_ID ?? defaultOrgId(),
		role: workosRole(process.env.ZMAIL_TEST_AUTH_ROLE ?? "org_admin"),
		permissions: ["*"],
		authMode: "workos",
	};
}

function setBrowserSessionCookie(c: Context, sealedSession: string) {
	setCookie(c, SESSION_COOKIE, sealedSession, cookieOptions(c));
}

async function browserPrincipalFromCookie(c: Context) {
	const sessionData = getCookie(c, SESSION_COOKIE);
	if (!sessionData) {
		return null;
	}
	return browserPrincipalFromSessionData(sessionData, () => {
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
	});
}

async function browserPrincipalFromSessionData(
	sessionData: string,
	onInvalid?: () => void,
) {
	const workos = getWorkOS();
	const result = await workos.userManagement.authenticateWithSessionCookie({
		sessionData,
		cookiePassword: requireEnv("WORKOS_COOKIE_PASSWORD"),
	});
	if (!result.authenticated) {
		onInvalid?.();
		return null;
	}
	const principal: BrowserPrincipal = {
		kind: "browser",
		sub: result.user.id,
		email: result.user.email,
		orgId: result.organizationId ?? null,
		role: result.organizationId
			? workosRoleFromSlugs(result.role, result.roles)
			: null,
		permissions: result.permissions ?? [],
		authMode: "workos",
	};
	return principal;
}

function cookieValue(cookieHeader: string | null | undefined, name: string) {
	for (const part of (cookieHeader ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0) {
			continue;
		}
		const key = part.slice(0, separator).trim();
		if (key !== name) {
			continue;
		}
		return decodeURIComponent(part.slice(separator + 1).trim());
	}
	return null;
}

export async function resolveBrowserPrincipalFromRequest(request: Request) {
	if (request.headers.get("authorization")?.startsWith("Bearer ")) {
		return {
			ok: false as const,
			status: 401 as const,
			error: "machine_tokens_not_allowed",
		};
	}
	if (testAuthBypassEnabled()) {
		return { ok: true as const, principal: testBrowserPrincipal() };
	}
	const sessionData = cookieValue(
		request.headers.get("cookie"),
		SESSION_COOKIE,
	);
	if (!sessionData) {
		return {
			ok: false as const,
			status: 401 as const,
			error: "unauthenticated",
		};
	}
	const principal = await browserPrincipalFromSessionData(sessionData);
	if (!principal) {
		return {
			ok: false as const,
			status: 401 as const,
			error: "unauthenticated",
		};
	}
	return { ok: true as const, principal };
}

async function listActiveMemberships(
	userId: string,
): Promise<BrowserMembership[]> {
	const workos = getWorkOS();
	const paginatedMemberships =
		await workos.userManagement.listOrganizationMemberships({
			userId,
			statuses: ["active"],
		});
	const memberships = await paginatedMemberships.autoPagination();
	return memberships.map((membership) => ({
		id: membership.id,
		organizationId: membership.organizationId,
		organizationName: membership.organizationName,
		role: workosRoleFromResponses(membership.role, membership.roles),
	}));
}

async function refreshBrowserSessionToOrg(
	c: Context,
	principal: BrowserPrincipal,
	organizationId: string,
) {
	const sessionData = getCookie(c, SESSION_COOKIE);
	if (!sessionData) {
		return null;
	}
	const sessionCookie = sessionData;

	const workos = getWorkOS();
	const session = workos.userManagement.loadSealedSession({
		sessionData: sessionCookie,
		cookiePassword: requireEnv("WORKOS_COOKIE_PASSWORD"),
	});
	const refreshed = await session.refresh({
		organizationId,
		cookiePassword: requireEnv("WORKOS_COOKIE_PASSWORD"),
	});
	if (
		!refreshed.authenticated ||
		!("sealedSession" in refreshed) ||
		!refreshed.sealedSession
	) {
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		return null;
	}

	setBrowserSessionCookie(c, refreshed.sealedSession);
	return {
		kind: "browser",
		sub: principal.sub,
		email: principal.email,
		orgId: refreshed.organizationId ?? organizationId,
		role: workosRoleFromSlugs(refreshed.role, refreshed.roles),
		permissions: refreshed.permissions ?? [],
		authMode: "workos",
	} satisfies BrowserPrincipal;
}

function setBrowserPrincipal(c: Context, principal: BrowserPrincipal) {
	if (!principal.orgId) {
		throw new Error("Active browser principal requires an organization.");
	}
	c.set("principal", principal);
	c.set("orgId", principal.orgId);
}

function throwWorkOsRoleConfigurationError(
	event: string,
	error: unknown,
	fields?: Record<string, string>,
): never {
	startTrace({
		kind: "auth",
		operation: "workos_role_configuration",
		...fields,
	}).fail(event, error);
	throw new WorkOsRoleConfigurationError(error);
}

async function listEnvironmentRoleSlugs(workos: ReturnType<typeof getWorkOS>) {
	const existing = await workos.authorization.listEnvironmentRoles();
	return new Set(existing.data.map((role) => role.slug));
}

async function ensureEnvironmentRoles() {
	const workos = getWorkOS();
	let existingSlugs: Set<string>;
	try {
		existingSlugs = await listEnvironmentRoleSlugs(workos);
	} catch (error) {
		return throwWorkOsRoleConfigurationError(
			"auth.workos.environment_roles.list_failed",
			error,
		);
	}
	for (const role of ENVIRONMENT_ROLE_DEFS) {
		if (existingSlugs.has(role.slug)) {
			continue;
		}
		try {
			await workos.authorization.createEnvironmentRole(role);
			existingSlugs.add(role.slug);
		} catch (error) {
			try {
				existingSlugs = await listEnvironmentRoleSlugs(workos);
			} catch (reloadError) {
				return throwWorkOsRoleConfigurationError(
					"auth.workos.environment_roles.reload_failed",
					reloadError,
					{ role_slug: role.slug },
				);
			}
			if (existingSlugs.has(role.slug)) {
				continue;
			}
			return throwWorkOsRoleConfigurationError(
				"auth.workos.environment_roles.seed_failed",
				error,
				{ role_slug: role.slug },
			);
		}
	}
}

export async function ensureBootstrapAdminPrincipal(
	c: Context,
	principal: BrowserPrincipal,
	memberships?: BrowserMembership[],
) {
	if (!principal.orgId || principal.role === "org_admin") {
		return principal;
	}
	if (!isBootstrapAdminEmail(principal.email)) {
		return principal;
	}

	const activeMemberships =
		memberships ?? (await listActiveMemberships(principal.sub));
	const membership = activeMemberships.find(
		(item) => item.organizationId === principal.orgId,
	);
	if (!membership) {
		return principal;
	}

	await ensureEnvironmentRoles();
	const workos = getWorkOS();
	try {
		await workos.userManagement.updateOrganizationMembership(membership.id, {
			roleSlug: "org_admin",
		});
	} catch (error) {
		return throwWorkOsRoleConfigurationError(
			"auth.workos.membership.update_failed",
			error,
			{
				membership_id: membership.id,
				organization_id: principal.orgId,
				role_slug: "org_admin",
			},
		);
	}
	return refreshBrowserSessionToOrg(c, principal, principal.orgId);
}

async function browserOrgBoundary(
	c: Context,
	principal: BrowserPrincipal,
	next: () => Promise<void>,
) {
	const pathname = stripBasePath(new URL(c.req.url).pathname);
	let activePrincipal = principal;
	let memberships: BrowserMembership[] | undefined;
	if (!activePrincipal.orgId) {
		memberships = await listActiveMemberships(activePrincipal.sub);
		if (memberships.length === 0) {
			return redirectToOrgCreate(c);
		}
		if (memberships.length > 1) {
			return redirectToOrgSelect(c);
		}
		const onlyMembership = memberships[0];
		if (!onlyMembership) {
			return redirectToOrgCreate(c);
		}
		const refreshed = await refreshBrowserSessionToOrg(
			c,
			activePrincipal,
			onlyMembership.organizationId,
		);
		if (!refreshed) {
			return redirectToLogin(c);
		}
		activePrincipal = refreshed;
	}
	const promotedPrincipal = await ensureBootstrapAdminPrincipal(
		c,
		activePrincipal,
		memberships,
	);
	if (!promotedPrincipal) {
		return redirectToLogin(c);
	}
	activePrincipal = promotedPrincipal;
	const activeOrgId = activePrincipal.orgId;
	if (!activeOrgId) {
		return redirectToOrgCreate(c);
	}

	if (
		activePrincipal.role === "org_admin" &&
		orgNeedsLegacyClaim(activeOrgId) &&
		!isClaimLegacyPath(pathname)
	) {
		return redirectToLegacyClaim(c);
	}

	setBrowserPrincipal(c, activePrincipal);
	return runWithOrgContext(activeOrgId, () => next());
}

export const browserSessionMiddleware: MiddlewareHandler = async (c, next) => {
	if (c.req.header("authorization")?.startsWith("Bearer ")) {
		return c.json(
			{
				ok: false,
				error: "machine_tokens_not_allowed",
			},
			401,
		);
	}

	if (testAuthBypassEnabled()) {
		const principal = testBrowserPrincipal();
		const orgId = principal.orgId;
		if (!orgId) {
			return redirectToOrgCreate(c);
		}
		setBrowserPrincipal(c, principal);
		return runWithOrgContext(orgId, () => next());
	}

	const principal = await browserPrincipalFromCookie(c);
	if (!principal) {
		return redirectToLogin(c);
	}

	c.set("principal", principal);
	if (!principal.orgId) {
		return next();
	}
	c.set("orgId", principal.orgId);
	return next();
};

export const activeBrowserOrgMiddleware: MiddlewareHandler = async (
	c,
	next,
) => {
	const principal = c.get("principal");
	if (!principal || principal.kind !== "browser") {
		return redirectToLogin(c);
	}
	if (testAuthBypassEnabled()) {
		const orgId = principal.orgId;
		if (!orgId) {
			return redirectToOrgCreate(c);
		}
		setBrowserPrincipal(c, principal);
		return runWithOrgContext(orgId, () => next());
	}
	return browserOrgBoundary(c, principal, next);
};

export function requireOrgRole(role: OrgRole): MiddlewareHandler {
	return async (c, next) => {
		const principal = c.get("principal");
		if (!principal || principal.kind !== "browser" || !principal.role) {
			return c.json(
				{
					ok: false,
					error: "forbidden",
				},
				403,
			);
		}
		if (ORG_ROLE_ORDER[principal.role] < ORG_ROLE_ORDER[role]) {
			return c.json(
				{
					ok: false,
					error: "forbidden",
				},
				403,
			);
		}
		return next();
	};
}

export async function handleLogin(c: Context) {
	if (testAuthBypassEnabled()) {
		return c.redirect(appPath("/"));
	}

	const workos = getWorkOS();
	const returnTo = safeReturnTo(c.req.query("returnTo"));
	const redirectUri = workosRedirectUri();
	const { url, state, codeVerifier } =
		await workos.userManagement.getAuthorizationUrlWithPKCE({
			provider: "authkit",
			redirectUri,
			clientId: requireEnv("WORKOS_CLIENT_ID"),
		});
	writeWorkOsState({
		state,
		codeVerifier,
		returnTo,
	});
	return c.redirect(url);
}

export async function handleAuthCallback(c: Context) {
	if (testAuthBypassEnabled()) {
		return c.redirect(appPath("/"));
	}

	const code = c.req.query("code");
	const state = c.req.query("state");
	if (!code || !state) {
		return c.html("<h1>Missing WorkOS callback parameters</h1>", 400);
	}
	const stored = readWorkOsState(state);
	if (!stored) {
		return c.html("<h1>Invalid or expired WorkOS login state</h1>", 400);
	}

	const workos = getWorkOS();
	const authResponse = await workos.userManagement.authenticateWithCode({
		code,
		codeVerifier: stored.codeVerifier,
		clientId: requireEnv("WORKOS_CLIENT_ID"),
		session: {
			sealSession: true,
			cookiePassword: requireEnv("WORKOS_COOKIE_PASSWORD"),
		},
	});
	if (!("sealedSession" in authResponse) || !authResponse.sealedSession) {
		return c.html("<h1>WorkOS login did not return a session</h1>", 500);
	}
	setBrowserSessionCookie(c, authResponse.sealedSession);
	startTrace({
		kind: "auth",
		operation: "workos_callback",
		org_id: authResponse.organizationId ?? undefined,
	}).complete("auth.workos.callback.complete");
	return c.redirect(safeReturnTo(stored.returnTo));
}

export async function handleLogout(c: Context) {
	const sessionData = getCookie(c, SESSION_COOKIE);
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	if (!sessionData) {
		return c.redirect(appPath("/"));
	}

	try {
		const workos = getWorkOS();
		const session = workos.userManagement.loadSealedSession({
			sessionData,
			cookiePassword: requireEnv("WORKOS_COOKIE_PASSWORD"),
		});
		const authenticated = await session.authenticate();
		if (!authenticated.authenticated) {
			return c.redirect(appPath("/"));
		}
		return c.redirect(
			workos.userManagement.getLogoutUrl({
				sessionId: authenticated.sessionId,
				returnTo: appUrl("/"),
			}),
		);
	} catch {
		return c.redirect(appPath("/"));
	}
}

export async function loadOrgSelectionData(c: Context) {
	const principal = c.get("principal");
	if (!principal || principal.kind !== "browser") {
		throw new Error("Browser principal is required.");
	}
	const memberships = await listActiveMemberships(principal.sub);
	return {
		principal,
		memberships,
		returnTo: safeReturnTo(c.req.query("returnTo")),
	};
}

export async function selectOrganizationForBrowserSession(
	c: Context,
	organizationId: string,
) {
	const principal = c.get("principal");
	if (!principal || principal.kind !== "browser") {
		throw new Error("Browser principal is required.");
	}
	const memberships = await listActiveMemberships(principal.sub);
	const membership = memberships.find(
		(item) => item.organizationId === organizationId,
	);
	if (!membership) {
		return c.json(
			{
				ok: false,
				error: "forbidden",
			},
			403,
		);
	}

	const refreshed = await refreshBrowserSessionToOrg(
		c,
		principal,
		organizationId,
	);
	if (!refreshed) {
		return redirectToLogin(c);
	}
	const promoted = await ensureBootstrapAdminPrincipal(c, refreshed, [
		membership,
	]);
	if (!promoted) {
		return redirectToLogin(c);
	}
	if (promoted.role === "org_admin" && orgNeedsLegacyClaim(organizationId)) {
		return c.redirect(
			appPath(
				`/org/claim-legacy?returnTo=${encodeURIComponent(safeReturnTo(c.req.query("returnTo")))}`,
			),
		);
	}
	return c.redirect(safeReturnTo(c.req.query("returnTo")));
}

export async function createOrganizationForBrowserSession(
	c: Context,
	organizationName: string,
) {
	const principal = c.get("principal");
	if (!principal || principal.kind !== "browser") {
		throw new Error("Browser principal is required.");
	}

	const workos = getWorkOS();
	const organization = await workos.organizations.createOrganization({
		name: organizationName,
	});
	await ensureEnvironmentRoles();
	try {
		await workos.userManagement.createOrganizationMembership({
			organizationId: organization.id,
			userId: principal.sub,
			roleSlug: "org_admin",
		});
	} catch (error) {
		return throwWorkOsRoleConfigurationError(
			"auth.workos.membership.create_failed",
			error,
			{
				organization_id: organization.id,
				role_slug: "org_admin",
			},
		);
	}
	const refreshed = await refreshBrowserSessionToOrg(
		c,
		principal,
		organization.id,
	);
	if (!refreshed) {
		return redirectToLogin(c);
	}
	if (orgNeedsLegacyClaim(organization.id)) {
		return c.redirect(
			appPath(
				`/org/claim-legacy?returnTo=${encodeURIComponent(safeReturnTo(c.req.query("returnTo")))}`,
			),
		);
	}
	return c.redirect(safeReturnTo(c.req.query("returnTo")));
}

export async function claimLegacyRuntimeForActiveOrg(c: Context) {
	const principal = c.get("principal");
	if (!principal || principal.kind !== "browser" || !principal.orgId) {
		throw new Error("Active browser principal is required.");
	}
	if (principal.role !== "org_admin") {
		return c.json(
			{
				ok: false,
				error: "forbidden",
			},
			403,
		);
	}
	claimLegacyRuntime(principal.orgId);
	return c.redirect(safeReturnTo(c.req.query("returnTo")));
}

export function isOrgSelectionPath(pathname: string) {
	const appPathname = stripBasePath(pathname);
	return appPathname === "/org/select" || appPathname === "/org/create";
}

export function isClaimLegacyPath(pathname: string) {
	return stripBasePath(pathname) === "/org/claim-legacy";
}

export function isBrowserPrincipal(
	principal: SessionPrincipal | undefined,
): principal is BrowserPrincipal {
	return principal?.kind === "browser";
}

export function currentBrowserOrgId() {
	return currentOrgId();
}
