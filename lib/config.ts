import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT_DIR = process.cwd();
export const DATA_DIR = resolve(
	process.env.ZMAIL_DATA_DIR ?? resolve(ROOT_DIR, "data"),
);
export const ACCOUNTS_DIR = resolve(DATA_DIR, "accounts");
export const OPERATOR_DIR = resolve(DATA_DIR, "operator");
export const REGISTRY_DIR = resolve(
	process.env.ZMAIL_REGISTRY_DIR ?? resolve(OPERATOR_DIR, "registry"),
);
export const CLASSIFICATION_DIR = resolve(
	process.env.ZMAIL_CLASSIFICATION_DIR ??
		resolve(OPERATOR_DIR, "classification"),
);
export const TMP_DIR = resolve(DATA_DIR, "tmp");
export const OAUTH_TMP_DIR = resolve(TMP_DIR, "oauth", "google");
export const DB_PATH = resolve(DATA_DIR, "zmail.sqlite");
export const PI_SUBSCRIPTION_PATH = resolve(
	DATA_DIR,
	"openai-subscription.json",
);
export const MIGRATIONS_DIR = resolve(ROOT_DIR, "db", "migrations");
export const PROMPTS_DIR = resolve(
	process.env.ZMAIL_PROMPTS_DIR ?? resolve(ROOT_DIR, "prompts"),
);

export function accountDir(accountId: string) {
	return resolve(ACCOUNTS_DIR, accountId);
}

export function accountOAuthPath(accountId: string) {
	return resolve(accountDir(accountId), "google-oauth.json");
}

export function accountRawDir(accountId: string) {
	return resolve(accountDir(accountId), "raw");
}

const REMOTE_MESSAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;

export function rawEmlPath(accountId: string, remoteMessageId: string) {
	if (!remoteMessageId || !REMOTE_MESSAGE_ID_RE.test(remoteMessageId)) {
		throw new Error("Invalid remoteMessageId");
	}

	return resolve(accountRawDir(accountId), `${remoteMessageId}.eml`);
}

export const CLASSIFY_PROMPT_VERSION = "classify-email-v2";
export const OVERSEER_PROMPT_VERSION = "overseer-profile-v1";
export const MODERATION_PROMPT_VERSION = "moderate-email-v1";
export const FINANCE_INTEL_PROMPT_VERSION = "finance-intel-v2";
export const FINANCE_KNOWLEDGE_PROMPT_VERSION = "finance-knowledge-merge-v1";

export const GOOGLE_OAUTH = {
	clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
	clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
	redirectUrl:
		process.env.GOOGLE_OAUTH_REDIRECT_URL ??
		"http://127.0.0.1:3000/oauth/google/callback",
	scope: "openid email profile https://mail.google.com/",
} as const;

export const APP_CONFIG = {
	classifierModel: process.env.ZMAIL_CLASSIFIER_MODEL ?? "gpt-5.4-mini",
	fallbackModel: process.env.ZMAIL_FALLBACK_MODEL ?? "gpt-5-mini",
	moderationModel:
		process.env.ZMAIL_MODERATION_MODEL ??
		process.env.ZMAIL_CLASSIFIER_MODEL ??
		"gpt-5.4-mini",
	piBackend: process.env.ZMAIL_PI_BACKEND ?? "auto",
	liveConcurrency: Math.max(
		1,
		Number(process.env.ZMAIL_LIVE_CONCURRENCY ?? "2"),
	),
	lowConfidenceThreshold: Number(process.env.LOW_CONFIDENCE_THRESHOLD ?? "0.8"),
	nsfwThreshold: Number(process.env.NSFW_THRESHOLD ?? "0.6"),
	overseerRebuildEvery: Number(process.env.OVERSEER_REBUILD_EVERY ?? "15000"),
	workerPollMs: Number(process.env.ZMAIL_WORKER_POLL_MS ?? "1000"),
	jobLeaseMs: 10 * 60 * 1000,
	liveHeartbeatMs: Number(process.env.ZMAIL_LIVE_HEARTBEAT_MS ?? "30000"),
	runWorker: (process.env.RUN_WORKER ?? "true") === "true",
	registryDir: REGISTRY_DIR,
	classificationDir: CLASSIFICATION_DIR,
	imapFetchWindow: Math.max(
		1,
		Number(process.env.ZMAIL_IMAP_FETCH_WINDOW ?? "250"),
	),
	imapPollMs: Number(process.env.ZMAIL_IMAP_POLL_MS ?? "300000"),
	imapMaxIdleMs: Number(process.env.ZMAIL_IMAP_MAX_IDLE_MS ?? "600000"),
	syncReconcileMs: Number(process.env.ZMAIL_SYNC_RECONCILE_MS ?? "86400000"),
} as const;

export function ensureStorageDirs() {
	for (const path of [
		DATA_DIR,
		ACCOUNTS_DIR,
		OPERATOR_DIR,
		REGISTRY_DIR,
		CLASSIFICATION_DIR,
		TMP_DIR,
		OAUTH_TMP_DIR,
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
