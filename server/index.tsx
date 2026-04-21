/** @jsxImportSource hono/jsx */
import { isAbsolute } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { zValidator } from "@hono/zod-validator";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import { appPath, loadResolvedConfig, stripBasePath } from "#/lib/app-config";
import { APP_CONFIG, PROMPTS_DIR } from "#/lib/config";
import { ensureAccountOwnershipBackfill, runMigrations } from "#/lib/db";
import { startTrace } from "#/lib/log";
import {
	metricsContentType,
	metricsText,
	normalizeHttpRoute,
	recordHttpRequest,
} from "#/lib/observability";
import { runWithOrgContext } from "#/lib/runtime";
import {
	latestRuntimeEventId,
	listRuntimeEvents,
	runtimeEventEnvelope,
	waitForRuntimeEvent,
} from "#/lib/runtime-events";
import {
	classifyReviewBacklogInputSchema,
	classifyRootMessagesInputSchema,
	financeMappingUpsertInputSchema,
	taxBusinessQuarterPackageInputSchema,
	taxPersonalPackageInputSchema,
} from "#/lib/schemas";
import {
	applyFinanceMappingSuggestionCommand,
	beginGoogleConnectCommand,
	beginGoogleReconnectCommand,
	classifyOneNowCommand,
	completeGoogleConnectCommand,
	disconnectAccountCommand,
	loadAccountDeleteData,
	loadAccountDetailData,
	loadAccountLifecycleAccessData,
	loadAccountNewData,
	loadAccountReconnectData,
	loadAccountsData,
	loadFinanceData,
	loadHomeData,
	loadMessageDetailData,
	loadMessagesData,
	loadProfileData,
	loadReviewData,
	loadRunsData,
	pauseAccountSyncCommand,
	purgeAccountCommand,
	queueAccountClassifyBacklogCommand,
	queueAccountDeltaSyncCommand,
	queueAccountFinanceBacklogCommand,
	queueAccountFullSyncCommand,
	queueAccountReconcileCommand,
	queueFinanceExportCommand,
	queueGenerateFinanceMappingCandidatesCommand,
	queueImportFinanceArtifactCommand,
	queueImportOperatorRegistryCommand,
	queueRebuildFinanceKnowledgeCommand,
	queueRebuildFinanceRollupsCommand,
	queueReconcileRegistrySuggestionsCommand,
	queueReviewClassifierCommand,
	queueTargetedRootMessagesCommand,
	queueTaxBusinessQuarterPackageCommand,
	queueTaxPersonalPackageCommand,
	resolveReviewCommand,
	resumeAccountSyncCommand,
	upsertFinanceMappingCommand,
} from "#/server/actions";
import {
	activeBrowserOrgMiddleware,
	assertWorkOsBootstrapEnv,
	type BrowserPrincipal,
	browserSessionMiddleware,
	claimLegacyRuntimeForActiveOrg,
	createOrganizationForBrowserSession,
	handleAuthCallback,
	handleLogin,
	handleLogout,
	loadOrgSelectionData,
	requireOrgRole,
	type SessionPrincipal,
	safeReturnTo,
	selectOrganizationForBrowserSession,
	WorkOsRoleConfigurationError,
} from "#/server/auth";
import {
	authenticateMachineToken,
	bearerTokenFromRequest,
} from "#/server/machine-auth";
import { loadOpsHealth } from "#/server/ops-health";
import {
	DocumentShell,
	IslandFragmentEnvelope,
	type IslandRenderMap,
	PartialMain,
	renderAccountDeletePage,
	renderAccountDetailIslandMap,
	renderAccountDetailPage,
	renderAccountFormPage,
	renderAccountsIslandMap,
	renderAccountsPage,
	renderFinanceIslandMap,
	renderFinancePage,
	renderHomeIslandMap,
	renderHomePage,
	renderMessageDetailIslandMap,
	renderMessageDetailPage,
	renderMessagesPage,
	renderOrgClaimLegacyPage,
	renderOrgCreatePage,
	renderOrgSelectPage,
	renderProfileIslandMap,
	renderProfilePage,
	renderReviewIslandMap,
	renderReviewPage,
	renderRunsIslandMap,
	renderRunsPage,
} from "#/server/ui";

const config = loadResolvedConfig();
const port = config.server.bindPort;
const hostname = config.server.bindHost;
assertWorkOsBootstrapEnv();

const FINANCE_UPLOAD_HTTP_MAX_BYTES = 110 * 1024 * 1024;

const app = new Hono();
const webApp = config.server.basePath === "/" ? app : new Hono();

const reviewResolveSchema = z.object({
	action: z.enum(["accept", "override"]),
	override: z.unknown().optional(),
	note: z.string().nullable().optional(),
});

function isBrowserFinanceExportSubpath(value: string) {
	const trimmed = value.trim();
	if (!trimmed || isAbsolute(trimmed) || trimmed.includes("\0")) {
		return false;
	}
	return !trimmed.split(/[\\/]+/).includes("..");
}

const financeExportRequestSchema = z.object({
	year: z.number().int().min(1900).max(2500).nullable().optional(),
	outDir: z
		.string()
		.min(1)
		.refine(isBrowserFinanceExportSubpath, {
			message:
				"outDir must be a relative path inside the org finance export directory.",
		})
		.nullable()
		.optional(),
	strict: z.boolean().optional(),
	force: z.boolean().optional(),
});

const financeMappingGenerateInputSchema = z.object({
	year: z.number().int().min(1900).max(2500).nullable().optional(),
});

function renderPage(
	c: Context,
	input: {
		title: string;
		page: string;
		children: unknown;
		islands?: IslandRenderMap;
	},
) {
	const orgId = c.get("orgId");
	const eventCursor = latestRuntimeEventId(orgId);
	const stateScope = `org:${orgId}`;
	const url = new URL(c.req.url);
	if (c.req.header("X-Zmail-Partial") === "islands") {
		const requested = (c.req.header("X-Zmail-Islands") ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		const knownIslands = input.islands ?? {};
		const targetIds = requested.length ? requested : Object.keys(knownIslands);
		const availableIds = targetIds.filter((id) =>
			Object.hasOwn(knownIslands, id),
		);
		const missingIds = targetIds.filter(
			(id) => !Object.hasOwn(knownIslands, id),
		);
		c.header("X-Zmail-Title", input.title);
		c.header("X-Zmail-Url", `${url.pathname}${url.search}`);
		c.header("X-Zmail-Page", input.page);
		c.header("X-Zmail-Event-Cursor", String(eventCursor));
		c.header("X-Zmail-Islands", availableIds.join(","));
		if (missingIds.length > 0) {
			c.header("X-Zmail-Island-Missing", missingIds.join(","));
		}
		return c.html(
			<IslandFragmentEnvelope page={input.page} eventCursor={eventCursor}>
				{availableIds.map((id) => knownIslands[id])}
			</IslandFragmentEnvelope>,
		);
	}
	if (c.req.header("X-Zmail-Partial") === "main") {
		c.header("X-Zmail-Title", input.title);
		c.header("X-Zmail-Url", `${url.pathname}${url.search}`);
		c.header("X-Zmail-Page", input.page);
		c.header("X-Zmail-Event-Cursor", String(eventCursor));
		return c.html(
			<PartialMain page={input.page} eventCursor={eventCursor}>
				{input.children}
			</PartialMain>,
		);
	}

	return c.html(
		<DocumentShell
			title={input.title}
			page={input.page}
			eventCursor={eventCursor}
			stateScope={stateScope}
		>
			{input.children}
		</DocumentShell>,
	);
}

function okJson(status: string, extra: Record<string, unknown> = {}) {
	return {
		ok: true as const,
		status,
		...extra,
	};
}

function errorJson(error: string, message?: string, issues?: unknown) {
	return {
		ok: false as const,
		error,
		...(message !== undefined ? { message } : {}),
		...(issues ? { issues } : {}),
	};
}

function requirePageRole() {
	return requireOrgRole("org_viewer");
}

function orgRoleRank(role: BrowserPrincipal["role"]) {
	switch (role) {
		case "org_admin":
			return 2;
		case "org_operator":
			return 1;
		default:
			return 0;
	}
}

function normalizePrincipalEmail(email: string) {
	return email.trim().toLowerCase();
}

function canOperateAccount(principal: SessionPrincipal | undefined) {
	return (
		Boolean(principal) &&
		principal?.kind === "browser" &&
		principal.role !== null &&
		orgRoleRank(principal.role) >= orgRoleRank("org_operator")
	);
}

function canManageAccountLifecycle(
	principal: SessionPrincipal | undefined,
	ownerPrincipalEmail: string | null | undefined,
) {
	if (!principal || principal.kind !== "browser") {
		return false;
	}
	if (principal.role === "org_admin") {
		return true;
	}
	if (!ownerPrincipalEmail?.trim()) {
		return false;
	}
	return (
		normalizePrincipalEmail(principal.email) ===
		normalizePrincipalEmail(ownerPrincipalEmail)
	);
}

function renderForbiddenPage(c: Context, message: string) {
	c.status(403);
	return renderPage(c, {
		title: "Forbidden",
		page: "error",
		children: (
			<section class="card stack">
				<h1>Forbidden</h1>
				<p class="muted">{message}</p>
			</section>
		),
	});
}

async function requireAccountLifecycleAccess(
	c: Context,
	accountId: string,
	mode: "page" | "rpc",
) {
	const lifecycleData = await loadAccountLifecycleAccessData({ accountId });
	if (
		canManageAccountLifecycle(
			c.get("principal"),
			lifecycleData.account.owner_principal_email,
		)
	) {
		return lifecycleData;
	}
	if (mode === "rpc") {
		return c.json(errorJson("forbidden"), 403);
	}
	return renderForbiddenPage(
		c,
		"You do not have permission to manage this Gmail account.",
	);
}

function requestAppPath(c: Context) {
	return stripBasePath(new URL(c.req.url).pathname);
}

function isStructuredApiPath(c: Context) {
	const pathname = requestAppPath(c);
	return (
		pathname.startsWith("/rpc/") ||
		pathname.startsWith("/api/") ||
		pathname === "/events"
	);
}

const financeImportAuth: MiddlewareHandler = async (c, next) => {
	const bearerToken = bearerTokenFromRequest(c);
	if (bearerToken) {
		const principal = await authenticateMachineToken(bearerToken);
		if (principal === "unauthenticated") {
			return c.json(errorJson("unauthenticated"), 401);
		}
		if (principal === "forbidden") {
			return c.json(errorJson("forbidden"), 403);
		}
		c.set("principal", principal);
		c.set("orgId", principal.orgId);
		return runWithOrgContext(principal.orgId, () => next());
	}
	let nestedResponse: Response | undefined;
	let blockedResponse: Response | undefined;
	await browserSessionMiddleware(c, async () => {
		nestedResponse =
			(await activeBrowserOrgMiddleware(c, async () => {
				const principal = c.get("principal");
				if (!principal || principal.kind !== "browser") {
					blockedResponse = c.json(errorJson("unauthenticated"), 401);
					return;
				}
				if (!canOperateAccount(principal)) {
					blockedResponse = c.json(errorJson("forbidden"), 403);
					return;
				}
				await next();
			})) ?? undefined;
	});
	return blockedResponse ?? nestedResponse;
};

app.use(
	"*",
	secureHeaders({
		crossOriginEmbedderPolicy: false,
		permissionsPolicy: {
			camera: [],
			geolocation: [],
			microphone: [],
			payment: [],
			usb: [],
		},
	}),
);

app.use("*", async (c, next) => {
	const pathname = new URL(c.req.url).pathname;
	const trace = startTrace({
		kind: "http",
		operation: "request",
		method: c.req.method,
		path: pathname,
	});
	const startedAt = performance.now();
	try {
		await next();
		const durationMs = performance.now() - startedAt;
		if (config.logging.serverTiming) {
			c.header("Server-Timing", `app;dur=${durationMs.toFixed(1)}`);
		}
		if (config.logging.requestLogs) {
			trace.complete("http.request.complete", {
				status: c.res.status,
			});
		}
		if (pathname !== config.observability.metricsPath) {
			recordHttpRequest({
				method: c.req.method,
				route: normalizeHttpRoute(stripBasePath(pathname)),
				status: c.res.status,
				durationMs,
			});
		}
	} catch (error) {
		const durationMs = performance.now() - startedAt;
		if (config.logging.requestLogs) {
			trace.fail("http.request.fail", error, {
				status: c.res.status || 500,
			});
		}
		if (pathname !== config.observability.metricsPath) {
			recordHttpRequest({
				method: c.req.method,
				route: normalizeHttpRoute(stripBasePath(pathname)),
				status: c.res.status || 500,
				durationMs,
			});
		}
		throw error;
	}
});

app.use("/favicon.ico", serveStatic({ root: "./public" }));
app.use("/manifest.json", serveStatic({ root: "./public" }));
app.use("/logo192.png", serveStatic({ root: "./public" }));
app.use("/logo512.png", serveStatic({ root: "./public" }));
app.use("/robots.txt", serveStatic({ root: "./public" }));

app.get("/healthz", (c) => {
	return c.json(
		okJson("ok", {
			service: "zmail",
			version:
				process.env.ZMAIL_SERVICE_VERSION ??
				process.env.npm_package_version ??
				"dev",
			uptime_ms: Math.round(process.uptime() * 1000),
		}),
	);
});

app.get("/readyz", (c) => {
	return c.json(
		okJson("ready", {
			worker_enabled: config.worker.enabled,
			metrics_enabled: config.observability.metricsEnabled,
			log_file_enabled: Boolean(config.observability.logFile),
			base_path: config.server.basePath,
			data_root_configured: Boolean(config.data.rootDir),
		}),
	);
});

app.get(config.observability.metricsPath, async (c) => {
	if (!config.observability.metricsEnabled) {
		return c.json(errorJson("not_found"), 404);
	}
	c.header("Content-Type", metricsContentType());
	return c.body(await metricsText());
});

webApp.use("/client/*", serveStatic({ root: "./public" }));
webApp.use("/assets/*", serveStatic({ root: "./public" }));
// Browser ESM vendor routes for import-map modules only. Do not mount org data here.
webApp.use(
	"/vendor/echarts/*",
	serveStatic({
		root: "./node_modules/echarts",
		rewriteRequestPath: (path) => path.replace(/^\/vendor\/echarts/, ""),
	}),
);
webApp.use(
	"/vendor/tslib/*",
	serveStatic({
		root: "./node_modules/tslib",
		rewriteRequestPath: (path) => path.replace(/^\/vendor\/tslib/, ""),
	}),
);
webApp.use(
	"/vendor/zrender/*",
	serveStatic({
		root: "./node_modules/zrender",
		rewriteRequestPath: (path) => path.replace(/^\/vendor\/zrender/, ""),
	}),
);
webApp.all("/vendor/echarts/*", (c) => c.text("Not found", 404));
webApp.all("/vendor/tslib/*", (c) => c.text("Not found", 404));
webApp.all("/vendor/zrender/*", (c) => c.text("Not found", 404));

webApp.get("/auth/login", handleLogin);
webApp.get("/auth/callback", handleAuthCallback);
webApp.post("/auth/logout", handleLogout);

webApp.get("/org/select", browserSessionMiddleware, async (c) => {
	const data = await loadOrgSelectionData(c);
	if (data.memberships.length === 0) {
		return c.redirect(
			appPath(`/org/create?returnTo=${encodeURIComponent(data.returnTo)}`),
		);
	}
	if (data.memberships.length === 1) {
		const onlyMembership = data.memberships[0];
		if (!onlyMembership) {
			return c.redirect(
				appPath(`/org/create?returnTo=${encodeURIComponent(data.returnTo)}`),
			);
		}
		return selectOrganizationForBrowserSession(
			c,
			onlyMembership.organizationId,
		);
	}
	return renderPage(c, {
		title: "Select organization",
		page: "org-select",
		children: renderOrgSelectPage(data),
	});
});

webApp.post("/org/select", browserSessionMiddleware, async (c) => {
	const form = await c.req.formData();
	const organizationId = form.get("organizationId");
	if (typeof organizationId !== "string" || !organizationId.trim()) {
		return c.html("<h1>organizationId is required</h1>", 422);
	}
	return selectOrganizationForBrowserSession(c, organizationId.trim());
});

webApp.get("/org/create", browserSessionMiddleware, async (c) => {
	const data = await loadOrgSelectionData(c);
	if (data.memberships.length === 1) {
		const onlyMembership = data.memberships[0];
		if (!onlyMembership) {
			return c.redirect(
				appPath(`/org/select?returnTo=${encodeURIComponent(data.returnTo)}`),
			);
		}
		return selectOrganizationForBrowserSession(
			c,
			onlyMembership.organizationId,
		);
	}
	if (data.memberships.length > 1) {
		return c.redirect(
			appPath(`/org/select?returnTo=${encodeURIComponent(data.returnTo)}`),
		);
	}
	return renderPage(c, {
		title: "Create organization",
		page: "org-create",
		children: renderOrgCreatePage({
			principal: data.principal,
			returnTo: data.returnTo,
		}),
	});
});

webApp.post("/org/create", browserSessionMiddleware, async (c) => {
	const form = await c.req.formData();
	const organizationName = form.get("organizationName");
	if (typeof organizationName !== "string" || !organizationName.trim()) {
		return c.html("<h1>organizationName is required</h1>", 422);
	}
	return createOrganizationForBrowserSession(c, organizationName.trim());
});

webApp.get(
	"/org/claim-legacy",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_admin"),
	async (c) => {
		return renderPage(c, {
			title: "Claim legacy runtime",
			page: "org-claim-legacy",
			children: renderOrgClaimLegacyPage({
				orgId: c.get("orgId"),
				returnTo: safeReturnTo(c.req.query("returnTo")),
			}),
		});
	},
);

webApp.post(
	"/org/claim-legacy",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_admin"),
	async (c) => claimLegacyRuntimeForActiveOrg(c),
);

webApp.get(
	"/events",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_viewer"),
	async (c) => {
		runMigrations();
		const topics = [
			...new Set(
				(c.req.query("topics") ?? "")
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean),
			),
		].sort();
		const lastEventIdHeader = c.req.header("last-event-id");
		const cursorQuery = c.req.query("cursor");
		const cursorSeed = cursorQuery ?? lastEventIdHeader;
		const initialCursor =
			cursorSeed == null
				? latestRuntimeEventId(c.get("orgId"))
				: Number.parseInt(cursorSeed, 10);
		let cursor = Number.isFinite(initialCursor) ? initialCursor : 0;

		return streamSSE(c, async (stream) => {
			const replay = await listRuntimeEvents({
				topics,
				cursor,
				limit: 200,
			});
			for (const event of replay) {
				cursor = event.id;
				const envelope = runtimeEventEnvelope(event);
				await stream.writeSSE({
					id: String(envelope.id),
					event: envelope.event,
					data: JSON.stringify(envelope.data),
				});
			}

			while (true) {
				const next = await waitForRuntimeEvent({
					topics,
					cursor,
					timeoutMs: 15_000,
				});
				if (!next) {
					await stream.writeSSE({
						event: "heartbeat",
						data: JSON.stringify({
							at: new Date().toISOString(),
						}),
					});
					continue;
				}
				cursor = next.id;
				const envelope = runtimeEventEnvelope(next);
				await stream.writeSSE({
					id: String(envelope.id),
					event: envelope.event,
					data: JSON.stringify(envelope.data),
				});
			}
		});
	},
);

webApp.get(
	"/ops/health",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		const payload = await loadOpsHealth({
			orgId: c.get("orgId"),
			details: c.req.query("details") === "1",
		});
		return c.json(payload, payload.ok ? 200 : 503);
	},
);

webApp.get(
	"/",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const data = await loadHomeData();
		return renderPage(c, {
			title: "zmail",
			page: "home",
			children: renderHomePage(data),
			islands: renderHomeIslandMap(data),
		});
	},
);

webApp.get(
	"/accounts",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const data = await loadAccountsData();
		const principal = c.get("principal");
		const accountOptions = {
			canConnect: true,
			canManageLifecycle: (ownerPrincipalEmail: string | null) =>
				canManageAccountLifecycle(principal, ownerPrincipalEmail),
		};
		return renderPage(c, {
			title: "Accounts",
			page: "accounts",
			children: renderAccountsPage(data, accountOptions),
			islands: renderAccountsIslandMap(data, accountOptions),
		});
	},
);

webApp.get(
	"/accounts/new",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const data = await loadAccountNewData();
		return renderPage(c, {
			title: "Connect Gmail",
			page: "account-form",
			children: renderAccountFormPage({ mode: "connect", data }),
		});
	},
);

webApp.get(
	"/accounts/:accountId",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const accountId = c.req.param("accountId");
		if (!accountId) {
			return c.text("accountId is required", 400);
		}
		const data = await loadAccountDetailData({
			accountId,
		});
		const principal = c.get("principal");
		const accountOptions = {
			canManageLifecycle: canManageAccountLifecycle(
				principal,
				data.account.owner_principal_email,
			),
			canOperate: canOperateAccount(principal),
		};
		return renderPage(c, {
			title: data.account.label,
			page: "account-detail",
			children: renderAccountDetailPage(data, accountOptions),
			islands: renderAccountDetailIslandMap(data, accountOptions),
		});
	},
);

webApp.get(
	"/accounts/:accountId/reconnect",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const accountId = c.req.param("accountId");
		const access = await requireAccountLifecycleAccess(c, accountId, "page");
		if (access instanceof Response) {
			return access;
		}
		const data = await loadAccountReconnectData({
			accountId,
		});
		return renderPage(c, {
			title: "Reconnect Gmail",
			page: "account-form",
			children: renderAccountFormPage({ mode: "reconnect", data }),
		});
	},
);

webApp.get(
	"/accounts/:accountId/delete",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const accountId = c.req.param("accountId");
		const access = await requireAccountLifecycleAccess(c, accountId, "page");
		if (access instanceof Response) {
			return access;
		}
		const data = await loadAccountDeleteData({
			accountId,
		});
		return renderPage(c, {
			title: "Delete local account",
			page: "account-delete",
			children: renderAccountDeletePage(data),
		});
	},
);

webApp.get(
	"/messages",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const data = await loadMessagesData({
			q: c.req.query("q"),
			accountId: c.req.query("accountId"),
			bucket: c.req.query("bucket"),
			parseStatus: c.req.query("parseStatus"),
			page: c.req.query("page"),
			pageSize: c.req.query("pageSize"),
		});
		return renderPage(c, {
			title: "Messages",
			page: "messages",
			children: renderMessagesPage(data),
		});
	},
);

webApp.get(
	"/messages/:messageId",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const messageId = c.req.param("messageId");
		if (!messageId) {
			return c.text("messageId is required", 400);
		}
		const data = await loadMessageDetailData({
			messageId,
		});
		return renderPage(c, {
			title: data.message.subject ?? "Message",
			page: "message-detail",
			children: renderMessageDetailPage(data),
			islands: renderMessageDetailIslandMap(data),
		});
	},
);

webApp.get(
	"/review",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const data = await loadReviewData();
		return renderPage(c, {
			title: "Review",
			page: "review",
			children: renderReviewPage(data),
			islands: renderReviewIslandMap(data),
		});
	},
);

webApp.get(
	"/finance",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const year = c.req.query("year");
		const sourceKindQuery = c.req.query("sourceKind");
		const sourceKind =
			sourceKindQuery === "email" ||
			sourceKindQuery === "pdf" ||
			sourceKindQuery === "statement" ||
			sourceKindQuery === "csv" ||
			sourceKindQuery === "ofx"
				? sourceKindQuery
				: undefined;
		const data = await loadFinanceData({
			year: year ? Number.parseInt(year, 10) : undefined,
			accountId: c.req.query("accountId") ?? undefined,
			institutionId: c.req.query("institutionId") ?? undefined,
			ownerIdentityId: c.req.query("ownerIdentityId") ?? undefined,
			sourceKind,
		});
		const searchParams = new URL(c.req.url).searchParams;
		return renderPage(c, {
			title: "Finance",
			page: "finance",
			children: renderFinancePage(data, searchParams),
			islands: renderFinanceIslandMap(data, searchParams),
		});
	},
);

webApp.get(
	"/profiles/:accountId",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const accountId = c.req.param("accountId");
		if (!accountId) {
			return c.text("accountId is required", 400);
		}
		const data = await loadProfileData({
			accountId,
		});
		return renderPage(c, {
			title: "Overseer",
			page: "profiles",
			children: renderProfilePage(data),
			islands: renderProfileIslandMap(data),
		});
	},
);

webApp.get(
	"/runs",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const data = await loadRunsData();
		return renderPage(c, {
			title: "Runs",
			page: "runs",
			children: renderRunsPage(data),
			islands: renderRunsIslandMap(data),
		});
	},
);

webApp.get(
	"/oauth/google/callback",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const code = c.req.query("code");
		const state = c.req.query("state");
		if (!code || !state) {
			return renderPage(c, {
				title: "OAuth error",
				page: "oauth-callback",
				children: (
					<section class="card stack">
						<h1>OAuth callback error</h1>
						<p class="muted">Missing OAuth callback parameters.</p>
						<div class="actions">
							<a class="button" href={appPath("/accounts/new")}>
								Back to Connect Gmail
							</a>
							<a class="button secondary" href={appPath("/accounts")}>
								Back to Accounts
							</a>
						</div>
					</section>
				),
			});
		}

		try {
			await completeGoogleConnectCommand({ code, state });
			return c.redirect(appPath("/accounts"));
		} catch (error) {
			const message =
				error instanceof Error && error.message.trim()
					? error.message
					: "Google OAuth callback failed.";
			return renderPage(c, {
				title: "OAuth error",
				page: "oauth-callback",
				children: (
					<section class="card stack">
						<h1>OAuth callback error</h1>
						<p class="muted">{message}</p>
						<div class="actions">
							<a class="button" href={appPath("/accounts/new")}>
								Back to Connect Gmail
							</a>
							<a class="button secondary" href={appPath("/accounts")}>
								Back to Accounts
							</a>
						</div>
					</section>
				),
			});
		}
	},
);

webApp.post(
	"/rpc/accounts/connect/google",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requirePageRole(),
	async (c) => {
		const body = await c.req.json().catch(() => null);
		if (!body || typeof body.label !== "string" || !body.label.trim()) {
			return c.json(
				errorJson("invalid_body", "Account label is required."),
				422,
			);
		}
		const principal = c.get("principal");
		if (!principal || principal.kind !== "browser") {
			return c.json(errorJson("forbidden"), 403);
		}
		const result = await beginGoogleConnectCommand({
			label: body.label.trim(),
			ownerPrincipalEmail: principal.email,
		});
		return c.json(okJson("redirect", result));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/reconnect",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	async (c) => {
		const body = await c.req.json().catch(() => null);
		if (!body || typeof body.label !== "string" || !body.label.trim()) {
			return c.json(
				errorJson("invalid_body", "Account label is required."),
				422,
			);
		}
		const access = await requireAccountLifecycleAccess(
			c,
			c.req.param("accountId"),
			"rpc",
		);
		if (access instanceof Response) {
			return access;
		}
		const result = await beginGoogleReconnectCommand({
			accountId: c.req.param("accountId"),
			label: body.label.trim(),
		});
		return c.json(okJson("redirect", result));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/sync/full",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await queueAccountFullSyncCommand({ accountId: c.req.param("accountId") });
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/sync/delta",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await queueAccountDeltaSyncCommand({ accountId: c.req.param("accountId") });
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/sync/reconcile",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await queueAccountReconcileCommand({ accountId: c.req.param("accountId") });
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/classify/root",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await queueAccountClassifyBacklogCommand({
			accountId: c.req.param("accountId"),
		});
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/classify/root/messages",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	zValidator("json", classifyRootMessagesInputSchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await queueTargetedRootMessagesCommand({
			accountId: c.req.param("accountId"),
			messageIds: body.messageIds,
		});
		return c.json(okJson("queued", { jobId: result }));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/classify/finance",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await queueAccountFinanceBacklogCommand({
			accountId: c.req.param("accountId"),
		});
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/overseer/rebuild",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		const { enqueueOverseerCommand } = await import("#/server/actions");
		await enqueueOverseerCommand({ accountId: c.req.param("accountId") });
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/pause",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await pauseAccountSyncCommand({ accountId: c.req.param("accountId") });
		return c.json(okJson("paused"));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/resume",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await resumeAccountSyncCommand({ accountId: c.req.param("accountId") });
		return c.json(okJson("resumed"));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/disconnect",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	async (c) => {
		const access = await requireAccountLifecycleAccess(
			c,
			c.req.param("accountId"),
			"rpc",
		);
		if (access instanceof Response) {
			return access;
		}
		await disconnectAccountCommand({ accountId: c.req.param("accountId") });
		return c.json(okJson("disconnected"));
	},
);

webApp.post(
	"/rpc/accounts/:accountId/delete",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	async (c) => {
		const body = await c.req.json().catch(() => null);
		if (!body || typeof body.confirmationEmail !== "string") {
			return c.json(
				errorJson("invalid_body", "confirmationEmail is required."),
				422,
			);
		}
		const access = await requireAccountLifecycleAccess(
			c,
			c.req.param("accountId"),
			"rpc",
		);
		if (access instanceof Response) {
			return access;
		}
		await purgeAccountCommand({
			accountId: c.req.param("accountId"),
			confirmationEmail: body.confirmationEmail,
		});
		return c.json(okJson("deleted"));
	},
);

webApp.post(
	"/rpc/messages/:messageId/classify",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await classifyOneNowCommand({ messageId: c.req.param("messageId") });
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/reviews/:reviewId/resolve",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	zValidator("json", reviewResolveSchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await resolveReviewCommand({
			reviewId: c.req.param("reviewId"),
			action: body.action,
			override: body.override,
			note: body.note ?? undefined,
		});
		return c.json(okJson(result.status));
	},
);

webApp.post(
	"/rpc/reviews/classify",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	zValidator("json", classifyReviewBacklogInputSchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await queueReviewClassifierCommand({
			accountId: body.accountId,
			limit: body.limit,
		});
		return c.json(okJson("queued", { jobId: result }));
	},
);

webApp.post(
	"/rpc/finance/registry/import",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await queueImportOperatorRegistryCommand();
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/finance/suggestions/reconcile",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await queueReconcileRegistrySuggestionsCommand();
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/finance/knowledge/rebuild",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await queueRebuildFinanceKnowledgeCommand();
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/finance/rollups/rebuild",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		await queueRebuildFinanceRollupsCommand();
		return c.json(okJson("queued"));
	},
);

webApp.post(
	"/rpc/finance/mappings/upsert",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	zValidator("json", financeMappingUpsertInputSchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await upsertFinanceMappingCommand({ mapping: body.mapping });
		return c.json(okJson("queued", result));
	},
);

webApp.post(
	"/rpc/finance/mappings/generate",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	zValidator("json", financeMappingGenerateInputSchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await queueGenerateFinanceMappingCandidatesCommand({
			year: body.year ?? null,
		});
		return c.json(okJson("queued", { jobId: result }));
	},
);

webApp.post(
	"/rpc/finance/mappings/suggestions/:suggestionId/apply",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		const result = await applyFinanceMappingSuggestionCommand({
			suggestionId: c.req.param("suggestionId"),
		});
		return c.json(okJson("applied", result));
	},
);

webApp.post(
	"/rpc/finance/export",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	zValidator("json", financeExportRequestSchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await queueFinanceExportCommand({
			year: body.year ?? null,
			outDir: body.outDir ?? null,
			strict: body.strict ?? true,
			force: body.force ?? false,
		});
		return c.json(okJson("queued", result));
	},
);

webApp.post(
	"/rpc/finance/tax/personal",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	zValidator("json", taxPersonalPackageInputSchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await queueTaxPersonalPackageCommand({
			year: body.year,
			outDir: body.outDir ?? null,
		});
		return c.json(okJson("queued", result));
	},
);

webApp.post(
	"/rpc/finance/tax/business/inherent-design",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	zValidator("json", taxBusinessQuarterPackageInputSchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await queueTaxBusinessQuarterPackageCommand({
			year: body.year,
			quarter: body.quarter,
			businessSlug: body.businessSlug,
			outDir: body.outDir ?? null,
		});
		return c.json(okJson("queued", result));
	},
);

webApp.post(
	"/api/finance/uploads",
	bodyLimit({
		maxSize: FINANCE_UPLOAD_HTTP_MAX_BYTES,
		onError: (c) =>
			c.json(
				errorJson("payload_too_large", "Upload exceeds 100 MB limit."),
				413,
			),
	}),
	financeImportAuth,
	async (c) => {
		runMigrations();
		let form: FormData;
		try {
			form = await c.req.formData();
		} catch {
			return c.json(errorJson("invalid_multipart"), 400);
		}
		const file = form.get("file");
		if (
			!file ||
			typeof file !== "object" ||
			!("arrayBuffer" in file) ||
			!("name" in file)
		) {
			return c.json(errorJson("missing_file"), 422);
		}
		try {
			const { createFinanceUpload } = await import("#/lib/finance-upload");
			const result = await createFinanceUpload({
				file: file as File,
				mode:
					typeof form.get("mode") === "string"
						? String(form.get("mode"))
						: null,
				sourceKindHint:
					typeof form.get("sourceKindHint") === "string"
						? String(form.get("sourceKindHint"))
						: null,
				retention:
					typeof form.get("retention") === "string"
						? String(form.get("retention"))
						: null,
			});
			return c.json(
				okJson(result.status, {
					uploadId: result.uploadId,
					jobId: result.jobId,
				}),
				result.status === "already_imported" ? 200 : 202,
			);
		} catch (error) {
			return c.json(
				errorJson(
					"invalid_upload",
					error instanceof Error ? error.message : String(error),
				),
				422,
			);
		}
	},
);

webApp.post("/api/finance/imports", financeImportAuth, async (c) => {
	runMigrations();
	let rawArtifact: unknown;
	try {
		rawArtifact = await c.req.json();
	} catch {
		return c.json(errorJson("invalid_json"), 400);
	}

	try {
		const [
			{ financeSourceImportSchema },
			{ computeArtifactSha256, findFinanceImportRunByArtifact },
		] = await Promise.all([
			import("#/lib/schemas"),
			import("#/lib/finance-imports"),
		]);
		const artifact = financeSourceImportSchema.parse(rawArtifact);
		const artifactSha256 = computeArtifactSha256(artifact);
		const existing = await findFinanceImportRunByArtifact(artifactSha256);
		if (existing) {
			return c.json(
				okJson("already_imported", {
					importRunId: existing.id,
					artifactSha256,
				}),
				200,
			);
		}

		const jobId = await queueImportFinanceArtifactCommand({ artifact });
		return c.json(
			okJson("queued", {
				jobId,
				artifactSha256,
			}),
			202,
		);
	} catch (error) {
		return c.json(
			errorJson(
				"invalid_artifact",
				error instanceof Error ? error.message : String(error),
			),
			422,
		);
	}
});

webApp.notFound((c) => {
	return renderPage(c, {
		title: "Not found",
		page: "not-found",
		children: (
			<section class="card stack">
				<h1>Not found</h1>
				<p class="muted">The requested page does not exist.</p>
			</section>
		),
	});
});

webApp.onError((error, c) => {
	if (isStructuredApiPath(c)) {
		return c.json(
			errorJson(
				"internal_error",
				error instanceof Error
					? error.message
					: "The application could not complete this request.",
			),
			500,
		);
	}
	c.status(500);
	const title =
		error instanceof WorkOsRoleConfigurationError
			? "Authentication configuration error"
			: "Application error";
	return renderPage(c, {
		title,
		page: "error",
		children: (
			<section class="card stack">
				<h1>{title}</h1>
				<p class="muted">
					{error instanceof Error
						? error.message
						: "The application could not complete this request."}
				</p>
			</section>
		),
	});
});

if (config.server.basePath !== "/") {
	app.route(config.server.basePath, webApp);
	app.notFound((c) => c.text("Not found", 404));
	app.onError((error, c) => {
		if (requestAppPath(c).startsWith("/api/")) {
			return c.json(
				errorJson(
					"internal_error",
					error instanceof Error ? error.message : "Request failed.",
				),
				500,
			);
		}
		return c.text("Application error", 500);
	});
}

export type AppType = typeof app;
export { app };

const entrypointArg = process.argv[1];

if (entrypointArg && import.meta.url === new URL(entrypointArg, "file:").href) {
	runMigrations();
	await ensureAccountOwnershipBackfill();
	serve({
		fetch: app.fetch,
		hostname,
		port,
	});
	startTrace({
		kind: "process",
		operation: "server.startup",
	}).complete("server.listen", {
		public_origin: config.server.publicOrigin,
		base_path: config.server.basePath,
		bind_host: hostname,
		bind_port: port,
	});
	if (APP_CONFIG.runWorker) {
		const { ensureWorkerStarted } = await import("#/lib/worker");
		ensureWorkerStarted();
	}
	if (PROMPTS_DIR) {
		// keep the prompts dir import live so startup errors surface immediately
	}
}
