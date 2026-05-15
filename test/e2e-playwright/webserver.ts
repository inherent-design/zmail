import { resolve } from "node:path";

import { APP_CONFIG } from "#/lib/config";
import { runMigrations } from "#/lib/db";
import { createProductionServer } from "#/server/http";
import seedRuntimeForPlaywright, {
	seedRuntimeForPlaywrightAt,
} from "./global.setup";

const port = Number(process.env.PORT ?? "3030");

async function main() {
	const dataDir = process.env.ZMAIL_DATA_DIR;
	if (dataDir) {
		await seedRuntimeForPlaywrightAt({
			dataDir,
			runtimeRoot:
				process.env.ZMAIL_TEST_RUNTIME_ROOT ?? resolve(dataDir, ".."),
		});
	} else {
		await seedRuntimeForPlaywright();
	}
	runMigrations();
	const server = await createProductionServer();
	server.listen(port, "127.0.0.1", () => {
		console.log(`playwright zmail listening on http://127.0.0.1:${port}`);
	});
	if (APP_CONFIG.runWorker) {
		const { ensureWorkerStarted } = await import("#/lib/worker");
		ensureWorkerStarted();
	}
}

void main().catch((error) => {
	console.error(error);
	process.exit(1);
});
