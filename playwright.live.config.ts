import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const runtimeRoot = resolve(process.cwd(), "test/.runtime/e2e-live");
const dataDir = resolve(runtimeRoot, "data");
const port = 3030;

export default defineConfig({
	testDir: "./test/e2e-playwright",
	timeout: 180_000,
	fullyParallel: false,
	globalSetup: "./test/e2e-playwright/global.setup.ts",
	globalTeardown: "./test/e2e-playwright/global.teardown.ts",
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: "retain-on-failure",
	},
	webServer: {
		command: `pnpm router:generate && pnpm exec vite dev --port ${port}`,
		port,
		reuseExistingServer: false,
		timeout: 180_000,
		env: {
			...process.env,
			RUN_WORKER: "true",
			ZMAIL_DATA_DIR: dataDir,
			ZMAIL_PI_BACKEND: process.env.ZMAIL_PI_BACKEND ?? "auto",
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
