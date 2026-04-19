import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const ROOT_DIR = process.cwd();
const CONFIG_PATH = resolve(ROOT_DIR, "zmail.toml");

const rawConfigSchema = z
	.object({
		server: z
			.object({
				bind_host: z.string().min(1).optional(),
				bind_port: z.number().int().positive().optional(),
				public_origin: z.string().min(1).optional(),
				base_path: z.string().min(1).optional(),
			})
			.partial()
			.optional(),
		data: z
			.object({
				root_dir: z.string().min(1).optional(),
				default_org_id: z.string().min(1).optional(),
				force_org_layout: z.boolean().optional(),
			})
			.partial()
			.optional(),
		worker: z
			.object({
				enabled: z.boolean().optional(),
				poll_ms: z.number().int().positive().optional(),
				live_heartbeat_ms: z.number().int().positive().optional(),
			})
			.partial()
			.optional(),
		logging: z
			.object({
				level: z.string().min(1).optional(),
				format: z.string().min(1).optional(),
				request_logs: z.boolean().optional(),
				server_timing: z.boolean().optional(),
			})
			.partial()
			.optional(),
		observability: z
			.object({
				metrics_enabled: z.boolean().optional(),
				metrics_path: z.string().min(1).optional(),
				log_file: z.string().optional(),
				otlp_enabled: z.boolean().optional(),
				otlp_endpoint: z.string().optional(),
				service_instance_id: z.string().optional(),
			})
			.partial()
			.optional(),
		models: z
			.object({
				classifier: z.string().min(1).optional(),
				fallback: z.string().min(1).optional(),
				moderation: z.string().min(1).optional(),
				pi_backend: z.string().min(1).optional(),
			})
			.partial()
			.optional(),
		sync: z
			.object({
				live_concurrency: z.number().int().positive().optional(),
				imap_fetch_window: z.number().int().positive().optional(),
				imap_poll_ms: z.number().int().positive().optional(),
				imap_max_idle_ms: z.number().int().positive().optional(),
				reconcile_ms: z.number().int().positive().optional(),
			})
			.partial()
			.optional(),
		auth: z
			.object({
				workos: z
					.object({
						api_hostname: z.string().optional(),
						api_port: z.number().int().nonnegative().optional(),
						api_https: z.boolean().optional(),
						bootstrap_admin_emails: z.array(z.string().min(1)).optional(),
					})
					.partial()
					.optional(),
			})
			.partial()
			.optional(),
	})
	.partial();

export type RawZmailConfig = z.infer<typeof rawConfigSchema>;

export interface ResolvedZmailConfig {
	server: {
		bindHost: string;
		bindPort: number;
		publicOrigin: string;
		basePath: string;
	};
	data: {
		rootDir: string;
		defaultOrgId: string;
		forceOrgLayout: boolean;
	};
	worker: {
		enabled: boolean;
		pollMs: number;
		liveHeartbeatMs: number;
	};
	logging: {
		level: string;
		format: "json";
		requestLogs: boolean;
		serverTiming: boolean;
	};
	observability: {
		metricsEnabled: boolean;
		metricsPath: string;
		logFile: string | null;
		otlpEnabled: boolean;
		otlpEndpoint: string | null;
		serviceInstanceId: string;
	};
	models: {
		classifier: string;
		fallback: string;
		moderation: string;
		piBackend: string;
	};
	sync: {
		liveConcurrency: number;
		imapFetchWindow: number;
		imapPollMs: number;
		imapMaxIdleMs: number;
		reconcileMs: number;
	};
	auth: {
		workos: {
			apiHostname?: string;
			apiPort?: number;
			apiHttps: boolean;
			bootstrapAdminEmails: string[];
		};
	};
}

let cachedResolvedConfig: ResolvedZmailConfig | null = null;

function readRawConfig(): RawZmailConfig {
	if (!existsSync(CONFIG_PATH)) {
		return {};
	}
	const parsed = parseToml(readFileSync(CONFIG_PATH, "utf8"));
	return rawConfigSchema.parse(parsed);
}

function readStringEnv(name: string) {
	const value = process.env[name];
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function readExplicitUrlOverrideEnv(name: string) {
	const value = readStringEnv(name);
	if (!value || value.startsWith("REPLACE_ME_")) {
		return undefined;
	}
	new URL(value);
	return value;
}

function readIntEnv(name: string) {
	const value = readStringEnv(name);
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Invalid integer env for ${name}: ${value}`);
	}
	return parsed;
}

function readNonNegativeIntEnv(name: string) {
	const value = readStringEnv(name);
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`Invalid integer env for ${name}: ${value}`);
	}
	return parsed;
}

function readBoolEnv(name: string) {
	const value = readStringEnv(name);
	if (value === undefined) {
		return undefined;
	}
	switch (value.toLowerCase()) {
		case "true":
		case "1":
		case "yes":
		case "on":
			return true;
		case "false":
		case "0":
		case "no":
		case "off":
			return false;
		default:
			throw new Error(`Invalid boolean env for ${name}: ${value}`);
	}
}

function normalizeConfiguredEmails(input?: string[]) {
	return Array.from(
		new Set(
			(input ?? [])
				.map((value) => value.trim().toLowerCase())
				.filter((value) => value.length > 0),
		),
	);
}

function normalizeBasePath(input: string) {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) {
		throw new Error(`Invalid ZMAIL base_path: ${input}`);
	}
	if (trimmed === "/") {
		return "/";
	}
	const withoutTrailing = trimmed.replace(/\/+$/, "");
	if (!withoutTrailing.startsWith("/")) {
		throw new Error(`Invalid ZMAIL base_path: ${input}`);
	}
	return withoutTrailing;
}

function normalizeOrigin(input: string) {
	const parsed = new URL(input);
	if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
		throw new Error(`Invalid ZMAIL public_origin: ${input}`);
	}
	return parsed.toString().replace(/\/$/, "");
}

function resolveDataRoot(rootDir: string) {
	return resolve(ROOT_DIR, rootDir);
}

function normalizeMetricsPath(input: string) {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) {
		throw new Error(`Invalid ZMAIL metrics_path: ${input}`);
	}
	if (trimmed.includes("?") || trimmed.includes("#")) {
		throw new Error(`Invalid ZMAIL metrics_path: ${input}`);
	}
	const normalized =
		trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
	if (normalized === "/healthz" || normalized === "/readyz") {
		throw new Error(`Invalid ZMAIL metrics_path: ${input}`);
	}
	return normalized;
}

function normalizeOptionalUrl(input: string | null) {
	const trimmed = input?.trim() ?? "";
	if (!trimmed) {
		return null;
	}
	new URL(trimmed);
	return trimmed;
}

function normalizeLogFile(input: string | null) {
	const trimmed = input?.trim() ?? "";
	if (!trimmed) {
		return null;
	}
	const absolutePath = resolve(ROOT_DIR, trimmed);
	const publicDir = resolve(ROOT_DIR, "public");
	if (absolutePath === publicDir || absolutePath.startsWith(`${publicDir}/`)) {
		throw new Error(`Invalid ZMAIL log_file under public/: ${input}`);
	}
	return trimmed;
}

export function loadResolvedConfig(): ResolvedZmailConfig {
	if (cachedResolvedConfig) {
		return cachedResolvedConfig;
	}

	const raw = readRawConfig();
	const publicOrigin = normalizeOrigin(
		readStringEnv("ZMAIL_PUBLIC_ORIGIN") ??
			raw.server?.public_origin ??
			"http://127.0.0.1:56711",
	);
	const basePath = normalizeBasePath(
		readStringEnv("ZMAIL_BASE_PATH") ?? raw.server?.base_path ?? "/",
	);
	const bindPort =
		readIntEnv("ZMAIL_BIND_PORT") ??
		readIntEnv("PORT") ??
		raw.server?.bind_port ??
		56711;
	const bindHost =
		readStringEnv("ZMAIL_BIND_HOST") ?? raw.server?.bind_host ?? "127.0.0.1";
	const dataRootDir = resolveDataRoot(
		readStringEnv("ZMAIL_DATA_DIR") ?? raw.data?.root_dir ?? "data",
	);
	const defaultOrgId =
		readStringEnv("ZMAIL_DEFAULT_ORG_ID") ??
		readStringEnv("ZMAIL_ORG_ID") ??
		raw.data?.default_org_id ??
		"local";
	const forceOrgLayout =
		readBoolEnv("ZMAIL_FORCE_ORG_LAYOUT") ??
		raw.data?.force_org_layout ??
		false;
	const workerEnabled =
		readBoolEnv("ZMAIL_RUN_WORKER") ??
		readBoolEnv("RUN_WORKER") ??
		raw.worker?.enabled ??
		true;
	const workosApiPort =
		readNonNegativeIntEnv("WORKOS_API_PORT") ?? raw.auth?.workos?.api_port ?? 0;
	const loggingFormat =
		readStringEnv("ZMAIL_LOG_FORMAT") ?? raw.logging?.format ?? "json";
	if (loggingFormat !== "json") {
		throw new Error(`Unsupported ZMAIL log format: ${loggingFormat}`);
	}
	const metricsPath = normalizeMetricsPath(
		readStringEnv("ZMAIL_METRICS_PATH") ??
			raw.observability?.metrics_path ??
			"/metrics",
	);
	const logFile = normalizeLogFile(
		readStringEnv("ZMAIL_LOG_FILE") ?? raw.observability?.log_file ?? null,
	);
	const otlpEndpoint = normalizeOptionalUrl(
		readStringEnv("ZMAIL_OTLP_ENDPOINT") ??
			raw.observability?.otlp_endpoint ??
			null,
	);
	const serviceInstanceId =
		readStringEnv("ZMAIL_SERVICE_INSTANCE_ID") ??
		raw.observability?.service_instance_id?.trim() ??
		"";

	cachedResolvedConfig = {
		server: {
			bindHost,
			bindPort,
			publicOrigin,
			basePath,
		},
		data: {
			rootDir: dataRootDir,
			defaultOrgId,
			forceOrgLayout,
		},
		worker: {
			enabled: workerEnabled,
			pollMs: readIntEnv("ZMAIL_WORKER_POLL_MS") ?? raw.worker?.poll_ms ?? 1000,
			liveHeartbeatMs:
				readIntEnv("ZMAIL_LIVE_HEARTBEAT_MS") ??
				raw.worker?.live_heartbeat_ms ??
				30000,
		},
		logging: {
			level: readStringEnv("ZMAIL_LOG_LEVEL") ?? raw.logging?.level ?? "info",
			format: "json",
			requestLogs:
				readBoolEnv("ZMAIL_REQUEST_LOGS") ?? raw.logging?.request_logs ?? true,
			serverTiming:
				readBoolEnv("ZMAIL_SERVER_TIMING") ??
				raw.logging?.server_timing ??
				true,
		},
		observability: {
			metricsEnabled:
				readBoolEnv("ZMAIL_METRICS_ENABLED") ??
				raw.observability?.metrics_enabled ??
				false,
			metricsPath,
			logFile,
			otlpEnabled:
				readBoolEnv("ZMAIL_OTLP_ENABLED") ??
				raw.observability?.otlp_enabled ??
				false,
			otlpEndpoint,
			serviceInstanceId:
				serviceInstanceId.length > 0
					? serviceInstanceId
					: `${hostname()}:${String(process.pid)}`,
		},
		models: {
			classifier:
				readStringEnv("ZMAIL_CLASSIFIER_MODEL") ??
				raw.models?.classifier ??
				"gpt-5.4-mini",
			fallback:
				readStringEnv("ZMAIL_FALLBACK_MODEL") ??
				raw.models?.fallback ??
				"gpt-5-mini",
			moderation:
				readStringEnv("ZMAIL_MODERATION_MODEL") ??
				raw.models?.moderation ??
				readStringEnv("ZMAIL_CLASSIFIER_MODEL") ??
				raw.models?.classifier ??
				"gpt-5.4-mini",
			piBackend:
				readStringEnv("ZMAIL_PI_BACKEND") ?? raw.models?.pi_backend ?? "auto",
		},
		sync: {
			liveConcurrency:
				readIntEnv("ZMAIL_LIVE_CONCURRENCY") ?? raw.sync?.live_concurrency ?? 2,
			imapFetchWindow:
				readIntEnv("ZMAIL_IMAP_FETCH_WINDOW") ??
				raw.sync?.imap_fetch_window ??
				250,
			imapPollMs:
				readIntEnv("ZMAIL_IMAP_POLL_MS") ?? raw.sync?.imap_poll_ms ?? 300000,
			imapMaxIdleMs:
				readIntEnv("ZMAIL_IMAP_MAX_IDLE_MS") ??
				raw.sync?.imap_max_idle_ms ??
				600000,
			reconcileMs:
				readIntEnv("ZMAIL_SYNC_RECONCILE_MS") ??
				raw.sync?.reconcile_ms ??
				86400000,
		},
		auth: {
			workos: {
				apiHostname:
					readStringEnv("WORKOS_API_HOSTNAME") ??
					(raw.auth?.workos?.api_hostname || undefined),
				apiPort: workosApiPort > 0 ? workosApiPort : undefined,
				apiHttps:
					readBoolEnv("WORKOS_API_HTTPS") ??
					raw.auth?.workos?.api_https ??
					true,
				bootstrapAdminEmails: normalizeConfiguredEmails(
					raw.auth?.workos?.bootstrap_admin_emails,
				),
			},
		},
	};

	return cachedResolvedConfig;
}

export function appPath(path: string) {
	if (/^https?:\/\//i.test(path)) {
		return path;
	}
	if (!path.startsWith("/")) {
		throw new Error(`appPath requires an absolute path: ${path}`);
	}
	const { basePath } = loadResolvedConfig().server;
	if (basePath === "/") {
		return path;
	}
	return path === "/" ? basePath : `${basePath}${path}`;
}

export function assetPath(path: string) {
	return appPath(path);
}

export function stripBasePath(pathname: string) {
	const { basePath } = loadResolvedConfig().server;
	if (basePath === "/") {
		return pathname || "/";
	}
	if (pathname === basePath) {
		return "/";
	}
	if (pathname.startsWith(`${basePath}/`)) {
		return pathname.slice(basePath.length) || "/";
	}
	return pathname;
}

export function appUrl(path: string) {
	return new URL(
		appPath(path),
		`${loadResolvedConfig().server.publicOrigin}/`,
	).toString();
}

export function workosRedirectUri() {
	return (
		readExplicitUrlOverrideEnv("WORKOS_REDIRECT_URI") ??
		appUrl("/auth/callback")
	);
}

export function googleOAuthRedirectUrl() {
	return (
		readExplicitUrlOverrideEnv("GOOGLE_OAUTH_REDIRECT_URL") ??
		appUrl("/oauth/google/callback")
	);
}
