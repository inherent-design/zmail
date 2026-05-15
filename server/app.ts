import { isAbsolute } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { zValidator } from "@hono/zod-validator";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

import { loadResolvedConfig, stripBasePath } from "#/lib/app-config";
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
	financeMappingUpsertInputSchema,
	normalizeFinanceFilterSourceKind,
} from "#/lib/schemas";
import {
	queueGenerateFinanceMappingCandidatesCommand,
	queueImportFinanceArtifactCommand,
	upsertFinanceMappingCommand,
} from "#/server/actions";
import {
	activeBrowserOrgMiddleware,
	assertWorkOsBootstrapEnv,
	browserSessionMiddleware,
	claimLegacyRuntimeForActiveOrg,
	createOrganizationForBrowserSession,
	handleAuthCallback,
	handleLogin,
	handleLogout,
	requireOrgRole,
	selectOrganizationForBrowserSession,
} from "#/server/auth";
import {
	authenticateMachineToken,
	bearerTokenFromRequest,
} from "#/server/machine-auth";
import { mountRealtimeWebSocket } from "#/server/realtime-ws";

const FINANCE_UPLOAD_HTTP_MAX_BYTES = 110 * 1024 * 1024;

const config = loadResolvedConfig();
assertWorkOsBootstrapEnv();

export const honoApiApp = new Hono();
const webApp = config.server.basePath === "/" ? honoApiApp : new Hono();
export const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
	app: honoApiApp,
});

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

function clientEnvelope(status: string, extra: Record<string, unknown> = {}) {
	return okJson(status, extra);
}

function isBrowserFinanceExportSubpath(value: string) {
	const trimmed = value.trim();
	if (!trimmed || isAbsolute(trimmed) || trimmed.includes("\0")) {
		return false;
	}
	return !trimmed.split(/[\\/]+/).includes("..");
}

export const financeExportRequestSchema = z.object({
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
	strict: z
		.boolean()
		.refine((value) => value !== false, {
			message: "Only strict finance export is supported.",
		})
		.optional(),
	force: z.boolean().optional(),
});

let financeApiBootOnce: Promise<void> | null = null;

function bootFinanceApi() {
	if (!financeApiBootOnce) {
		financeApiBootOnce = Promise.resolve()
			.then(() => runMigrations())
			.catch((error) => {
				financeApiBootOnce = null;
				throw error;
			});
	}
	return financeApiBootOnce;
}

function canOperateBrowserPrincipal(principal: unknown) {
	return (
		principal !== null &&
		principal !== undefined &&
		typeof principal === "object" &&
		"kind" in principal &&
		principal.kind === "browser" &&
		"role" in principal &&
		(principal.role === "org_admin" || principal.role === "org_operator")
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
				if (!canOperateBrowserPrincipal(principal)) {
					blockedResponse = c.json(errorJson("forbidden"), 403);
					return;
				}
				await next();
			})) ?? undefined;
	});
	return blockedResponse ?? nestedResponse;
};

honoApiApp.use(
	"*",
	secureHeaders({
		contentSecurityPolicy: {
			connectSrc: ["'self'", "ws:", "wss:"],
		},
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

honoApiApp.use("*", async (c, next) => {
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
			trace.complete("http.request.complete", { status: c.res.status });
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

honoApiApp.use("/favicon.ico", serveStatic({ root: "./public" }));
honoApiApp.use("/manifest.json", serveStatic({ root: "./public" }));
honoApiApp.use("/logo192.png", serveStatic({ root: "./public" }));
honoApiApp.use("/logo512.png", serveStatic({ root: "./public" }));
honoApiApp.use("/robots.txt", serveStatic({ root: "./public" }));
webApp.use("/assets/*", serveStatic({ root: "./public" }));

honoApiApp.get("/healthz", (c) =>
	c.json(
		okJson("ok", {
			service: "zmail",
			version:
				process.env.ZMAIL_SERVICE_VERSION ??
				process.env.npm_package_version ??
				"dev",
			uptime_ms: Math.round(process.uptime() * 1000),
		}),
	),
);

honoApiApp.get("/readyz", (c) =>
	c.json(
		okJson("ready", {
			worker_enabled: config.worker.enabled,
			metrics_enabled: config.observability.metricsEnabled,
			log_file_enabled: Boolean(config.observability.logFile),
			base_path: config.server.basePath,
			data_root_configured: Boolean(config.data.rootDir),
		}),
	),
);

honoApiApp.get(config.observability.metricsPath, async (c) => {
	if (!config.observability.metricsEnabled) {
		return c.json(errorJson("not_found"), 404);
	}
	c.header("Content-Type", metricsContentType());
	return c.body(await metricsText());
});

webApp.get("/auth/login", handleLogin);
webApp.get("/auth/callback", handleAuthCallback);
webApp.post("/auth/logout", handleLogout);

webApp.post("/org/select", browserSessionMiddleware, async (c) => {
	const form = await c.req.formData();
	const organizationId = form.get("organizationId");
	if (typeof organizationId !== "string" || !organizationId.trim()) {
		return c.html("<h1>organizationId is required</h1>", 422);
	}
	return selectOrganizationForBrowserSession(c, organizationId.trim());
});

webApp.post("/org/create", browserSessionMiddleware, async (c) => {
	const form = await c.req.formData();
	const organizationName = form.get("organizationName");
	if (typeof organizationName !== "string" || !organizationName.trim()) {
		return c.html("<h1>organizationName is required</h1>", 422);
	}
	return createOrganizationForBrowserSession(c, organizationName.trim());
});

webApp.post(
	"/org/claim-legacy",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_admin"),
	async (c) => claimLegacyRuntimeForActiveOrg(c),
);

webApp.get(
	"/ops/health",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	async (c) => {
		const { loadOpsHealth } = await import("#/server/ops-health");
		const payload = await loadOpsHealth({
			orgId: c.get("orgId"),
			details: c.req.query("details") === "1",
		});
		return c.json(payload, payload.ok ? 200 : 503);
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
		return c.json(
			clientEnvelope("queued", {
				...result,
				toast: { tone: "success", text: "Mapping upsert queued." },
				invalidate: ["zmail:finance"],
			}),
		);
	},
);

webApp.post(
	"/rpc/finance/mappings/generate",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	requireOrgRole("org_operator"),
	zValidator("json", z.object({ year: z.number().nullable().optional() })),
	async (c) => {
		const body = c.req.valid("json");
		const jobId = await queueGenerateFinanceMappingCandidatesCommand({
			year: body.year ?? null,
		});
		return c.json(
			clientEnvelope("queued", {
				jobId,
				toast: { tone: "success", text: "Mapping candidate job queued." },
				invalidate: ["zmail:finance", "zmail:runs"],
				jobs: [
					{ jobId, kind: "finance_mapping_candidates", scopeId: "finance" },
				],
			}),
		);
	},
);

webApp.post(
	"/rpc/*",
	browserSessionMiddleware,
	activeBrowserOrgMiddleware,
	(c) =>
		c.json(
			clientEnvelope("accepted", {
				message:
					"This command route has not been migrated to the SvelteKit invalidation envelope yet.",
				invalidate: [
					"zmail:home",
					"zmail:accounts",
					"zmail:messages",
					"zmail:review",
					"zmail:finance",
					"zmail:runs",
				],
			}),
			202,
		),
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
		await bootFinanceApi();
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
				clientEnvelope(result.status, {
					uploadId: result.uploadId,
					jobId: result.jobId,
					toast: {
						tone: result.status === "already_imported" ? "warning" : "success",
						text:
							result.status === "already_imported"
								? "Upload already imported."
								: "Finance upload queued.",
					},
					invalidate: ["zmail:finance", "zmail:runs"],
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
	await bootFinanceApi();
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
			clientEnvelope("queued", {
				jobId,
				artifactSha256,
				invalidate: ["zmail:finance", "zmail:runs"],
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

webApp.get("/api/finance/filter-source-kinds", (c) =>
	c.json({
		ok: true,
		sourceKinds: [
			normalizeFinanceFilterSourceKind("bank"),
			normalizeFinanceFilterSourceKind("card"),
			normalizeFinanceFilterSourceKind("csv"),
			normalizeFinanceFilterSourceKind("email"),
		],
	}),
);

mountRealtimeWebSocket(webApp, upgradeWebSocket);

webApp.notFound((c) => c.text("Not found", 404));
webApp.onError((error, c) =>
	c.json(
		errorJson(
			"internal_error",
			error instanceof Error
				? error.message
				: "The application could not complete this request.",
		),
		500,
	),
);

if (config.server.basePath !== "/") {
	honoApiApp.route(config.server.basePath, webApp);
	honoApiApp.notFound((c) => c.text("Not found", 404));
}

export async function prepareApiRuntime() {
	runMigrations();
	await ensureAccountOwnershipBackfill();
}

export type AppType = typeof honoApiApp;
export const app = honoApiApp;
