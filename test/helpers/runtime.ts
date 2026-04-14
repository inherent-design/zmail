import { join } from "node:path";

import { vi } from "vitest";

import { setEnv } from "./env";
import { makeTempDir } from "./fs";

export async function createTestRuntime(prefix = "zmail-test-") {
	const root = await makeTempDir(prefix);
	const dataDir = join(root, "data");

	setEnv({
		ZMAIL_DATA_DIR: dataDir,
		RUN_WORKER: "false",
		ZMAIL_PI_BACKEND: "auto",
		ZMAIL_LIVE_CONCURRENCY: "2",
		LOW_CONFIDENCE_THRESHOLD: "0.8",
		NSFW_THRESHOLD: "0.6",
		OVERSEER_REBUILD_EVERY: "15000",
		GOOGLE_OAUTH_CLIENT_ID: undefined,
		GOOGLE_OAUTH_CLIENT_SECRET: undefined,
		GOOGLE_OAUTH_REDIRECT_URL: undefined,
		OPENAI_API_KEY: undefined,
	});

	vi.resetModules();

	return {
		root,
		dataDir,
		async importFresh<T>(specifier: string) {
			return (await import(specifier)) as T;
		},
	};
}
