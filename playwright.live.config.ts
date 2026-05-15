import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const runtimeRoot = resolve(process.cwd(), "test/.runtime/e2e-live");
const dataDir = resolve(runtimeRoot, "data");
const port = 3030;

export default defineConfig({
	testDir: "./test/e2e-playwright",
	timeout: 180_000,
	fullyParallel: false,
	workers: 1,
	globalTeardown: "./test/e2e-playwright/global.teardown.ts",
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: "retain-on-failure",
	},
	webServer: {
		command: `pnpm build && PORT=${port} pnpm exec tsx test/e2e-playwright/webserver.ts`,
		port,
		reuseExistingServer: false,
		timeout: 180_000,
		env: {
			...process.env,
			NODE_ENV: "test",
			RUN_WORKER: "true",
			ZMAIL_DATA_DIR: dataDir,
			ZMAIL_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
			ZMAIL_PI_BACKEND: process.env.ZMAIL_PI_BACKEND ?? "auto",
			ZMAIL_TEST_AUTH_BYPASS: "true",
			ZMAIL_TEST_AUTH_ORG_ID: process.env.ZMAIL_TEST_AUTH_ORG_ID ?? "local",
			ZMAIL_TEST_AUTH_ROLE: process.env.ZMAIL_TEST_AUTH_ROLE ?? "org_admin",
		},
	},
	projects: [
		{
			name: "chromium",
			use: {
				browserName: "chromium",
			},
		},
	],
});
