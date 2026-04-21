import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { googleOAuthRedirectUrl, loadResolvedConfig } from "#/lib/app-config";
import { currentOrgId, dataRootDir, runtimePaths } from "#/lib/runtime";

export const ROOT_DIR = process.cwd();
export const DATA_DIR = dataRootDir();
export const TMP_DIR = resolve(DATA_DIR, "tmp");
export const OAUTH_TMP_DIR = resolve(TMP_DIR, "oauth", "google");
export const PI_SUBSCRIPTION_PATH = resolve(
	DATA_DIR,
	"openai-subscription.json",
);
export const MIGRATIONS_DIR = resolve(ROOT_DIR, "db", "migrations");
export const PROMPTS_DIR = resolve(
	process.env.ZMAIL_PROMPTS_DIR ?? resolve(ROOT_DIR, "prompts"),
);

export function accountDir(accountId: string) {
	return runtimePaths().accountDir(accountId);
}

export function accountOAuthPath(accountId: string) {
	return runtimePaths().accountOAuthPath(accountId);
}

export function accountRawDir(accountId: string) {
	return runtimePaths().accountRawDir(accountId);
}

const REMOTE_MESSAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;

export function rawEmlPath(accountId: string, remoteMessageId: string) {
	if (!remoteMessageId || !REMOTE_MESSAGE_ID_RE.test(remoteMessageId)) {
		throw new Error("Invalid remoteMessageId");
	}

	return resolve(accountRawDir(accountId), `${remoteMessageId}.eml`);
}

export function dbPath(orgId = currentOrgId()) {
	return runtimePaths(orgId).dbPath;
}

export function accountsDir(orgId = currentOrgId()) {
	return runtimePaths(orgId).accountsDir;
}

export function operatorDir(orgId = currentOrgId()) {
	return runtimePaths(orgId).operatorDir;
}

export function registryDir(orgId = currentOrgId()) {
	return runtimePaths(orgId).registryDir;
}

export function classificationDir(orgId = currentOrgId()) {
	return runtimePaths(orgId).classificationDir;
}

export const DB_PATH = dbPath();
export const ACCOUNTS_DIR = accountsDir();
export const OPERATOR_DIR = operatorDir();
export const REGISTRY_DIR = registryDir();
export const CLASSIFICATION_DIR = classificationDir();
const RESOLVED_CONFIG = loadResolvedConfig();

function readGoogleOAuthBootstrapEnv(
	name: "GOOGLE_OAUTH_CLIENT_ID" | "GOOGLE_OAUTH_CLIENT_SECRET",
) {
	const value = process.env[name]?.trim();
	if (!value || value.startsWith("REPLACE_ME_")) {
		return "";
	}
	return value;
}

export const CLASSIFY_PROMPT_VERSION = "classify-email-v3";
export const OVERSEER_PROMPT_VERSION = "overseer-profile-v1";
export const MODERATION_PROMPT_VERSION = "moderate-email-v2";
export const FINANCE_INTEL_PROMPT_VERSION = "finance-intel-v3";
export const FINANCE_KNOWLEDGE_PROMPT_VERSION = "finance-knowledge-merge-v1";
export const REVIEW_CLASSIFIER_PROMPT_VERSION = "review-classifier-v1";

export const FINANCE_MODEL_TARGET_PROMPT_VERSIONS = {
	classify: "classify-email-v3",
	financeIntel: "finance-intel-v3",
	moderation: MODERATION_PROMPT_VERSION,
} as const;

export const GOOGLE_OAUTH = {
	get clientId() {
		return readGoogleOAuthBootstrapEnv("GOOGLE_OAUTH_CLIENT_ID");
	},
	get clientSecret() {
		return readGoogleOAuthBootstrapEnv("GOOGLE_OAUTH_CLIENT_SECRET");
	},
	get redirectUrl() {
		return googleOAuthRedirectUrl();
	},
	scope: "openid email profile https://mail.google.com/",
} as const;

export const APP_CONFIG = {
	classifierModel: RESOLVED_CONFIG.models.classifier,
	fallbackModel: RESOLVED_CONFIG.models.fallback,
	moderationModel: RESOLVED_CONFIG.models.moderation,
	piBackend: RESOLVED_CONFIG.models.piBackend,
	liveConcurrency: Math.max(1, RESOLVED_CONFIG.sync.liveConcurrency),
	lowConfidenceThreshold: Number(process.env.LOW_CONFIDENCE_THRESHOLD ?? "0.8"),
	nsfwThreshold: Number(process.env.NSFW_THRESHOLD ?? "0.6"),
	overseerBootstrapMinLabels: Number(
		process.env.OVERSEER_BOOTSTRAP_MIN_LABELS ?? "25",
	),
	overseerRebuildEvery: Number(process.env.OVERSEER_REBUILD_EVERY ?? "1000"),
	workerPollMs: RESOLVED_CONFIG.worker.pollMs,
	workerMaxJobConcurrency: RESOLVED_CONFIG.worker.maxJobConcurrency,
	workerLaneCaps: RESOLVED_CONFIG.worker.laneCaps,
	jobLeaseMs: 10 * 60 * 1000,
	liveHeartbeatMs: RESOLVED_CONFIG.worker.liveHeartbeatMs,
	runWorker: RESOLVED_CONFIG.worker.enabled,
	get registryDir() {
		return registryDir();
	},
	get classificationDir() {
		return classificationDir();
	},
	imapFetchWindow: Math.max(1, RESOLVED_CONFIG.sync.imapFetchWindow),
	imapPollMs: RESOLVED_CONFIG.sync.imapPollMs,
	imapMaxIdleMs: RESOLVED_CONFIG.sync.imapMaxIdleMs,
	syncReconcileMs: RESOLVED_CONFIG.sync.reconcileMs,
};

export function ensureStorageDirs() {
	const paths = runtimePaths();
	for (const path of [
		DATA_DIR,
		TMP_DIR,
		OAUTH_TMP_DIR,
		paths.rootDir,
		paths.accountsDir,
		paths.operatorDir,
		paths.registryDir,
		paths.classificationDir,
	]) {
		mkdirSync(path, { recursive: true });
	}
}

export function nowIso() {
	return new Date().toISOString();
}

export function requireOpenAiApiKey() {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_API_KEY is required for the openai-api backend");
	}
	return apiKey;
}

export function requireVoyageApiKey() {
	const apiKey = process.env.VOYAGE_API_KEY;
	if (!apiKey) {
		throw new Error("VOYAGE_API_KEY is required for Voyage embeddings");
	}
	return apiKey;
}
