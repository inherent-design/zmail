import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";

import { loadResolvedConfig } from "#/lib/app-config";

interface RuntimeContext {
	orgId: string;
}

const runtimeContext = new AsyncLocalStorage<RuntimeContext>();

export const DEFAULT_LOCAL_ORG_ID =
	process.env.ZMAIL_LOCAL_ORG_ID ?? loadResolvedConfig().data.defaultOrgId;

export function dataRootDir() {
	return loadResolvedConfig().data.rootDir;
}

export function orgsRootDir() {
	return resolve(dataRootDir(), "orgs");
}

export function defaultOrgId() {
	return loadResolvedConfig().data.defaultOrgId ?? DEFAULT_LOCAL_ORG_ID;
}

export function currentOrgId() {
	return runtimeContext.getStore()?.orgId ?? defaultOrgId();
}

export function runWithOrgContext<T>(orgId: string, fn: () => T) {
	return runtimeContext.run({ orgId }, fn);
}

export function orgRootDir(orgId = currentOrgId()) {
	return resolve(orgsRootDir(), orgId);
}

export function discoverOrgRuntimeIds() {
	const root = orgsRootDir();
	if (!existsSync(root)) {
		return [] as string[];
	}
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

export function legacyRuntimeExists() {
	const dataDir = dataRootDir();
	return (
		existsSync(resolve(dataDir, "zmail.sqlite")) ||
		existsSync(resolve(dataDir, "zmail.sqlite-shm")) ||
		existsSync(resolve(dataDir, "zmail.sqlite-wal")) ||
		existsSync(resolve(dataDir, "accounts")) ||
		existsSync(resolve(dataDir, "operator"))
	);
}

export function orgRuntimeExists(orgId: string) {
	return existsSync(orgRootDir(orgId));
}

export function orgNeedsLegacyClaim(orgId: string) {
	return legacyRuntimeExists() && !orgRuntimeExists(orgId);
}

function shouldUseLegacyCompatRoot(orgId: string) {
	if (loadResolvedConfig().data.forceOrgLayout) {
		return false;
	}
	if (existsSync(orgRootDir(orgId))) {
		return false;
	}
	return orgId === defaultOrgId() && legacyRuntimeExists();
}

function moveIfPresent(fromPath: string, toPath: string) {
	if (!existsSync(fromPath)) {
		return;
	}
	renameSync(fromPath, toPath);
}

export function claimLegacyRuntime(orgId: string) {
	if (!orgNeedsLegacyClaim(orgId)) {
		return false;
	}

	const dataDir = dataRootDir();
	const targetRoot = orgRootDir(orgId);
	mkdirSync(targetRoot, { recursive: true });

	moveIfPresent(
		resolve(dataDir, "zmail.sqlite"),
		resolve(targetRoot, "zmail.sqlite"),
	);
	moveIfPresent(
		resolve(dataDir, "zmail.sqlite-shm"),
		resolve(targetRoot, "zmail.sqlite-shm"),
	);
	moveIfPresent(
		resolve(dataDir, "zmail.sqlite-wal"),
		resolve(targetRoot, "zmail.sqlite-wal"),
	);
	moveIfPresent(resolve(dataDir, "accounts"), resolve(targetRoot, "accounts"));
	moveIfPresent(resolve(dataDir, "operator"), resolve(targetRoot, "operator"));

	return true;
}

export function runtimePaths(orgId = currentOrgId()) {
	const dataDir = dataRootDir();
	const rootDir = shouldUseLegacyCompatRoot(orgId)
		? dataDir
		: orgRootDir(orgId);
	const operatorDir = resolve(rootDir, "operator");
	const accountsDir = resolve(rootDir, "accounts");
	return {
		orgId,
		rootDir,
		dbPath: resolve(rootDir, "zmail.sqlite"),
		accountsDir,
		operatorDir,
		registryDir: resolve(operatorDir, "registry"),
		classificationDir: resolve(operatorDir, "classification"),
		accountDir(accountId: string) {
			return resolve(accountsDir, accountId);
		},
		accountOAuthPath(accountId: string) {
			return resolve(accountsDir, accountId, "google-oauth.json");
		},
		accountRawDir(accountId: string) {
			return resolve(accountsDir, accountId, "raw");
		},
		layout: rootDir === dataDir ? ("legacy-compat" as const) : ("org" as const),
	};
}
