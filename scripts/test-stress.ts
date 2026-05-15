import { setTimeout as sleep } from "node:timers/promises";

import { runCli } from "#/scripts/_shared";
import { buildWebSocketUrl, openWebSocketClient } from "#/scripts/_ws";

async function main() {
	const baseUrl = process.env.ZMAIL_BASE_URL ?? "http://127.0.0.1:56711";
	const clients = Number.parseInt(process.env.ZMAIL_STRESS_CLIENTS ?? "25", 10);
	const durationMs = Number.parseInt(
		process.env.ZMAIL_STRESS_DURATION_MS ?? "15000",
		10,
	);
	const topics =
		process.env.ZMAIL_STRESS_TOPICS ?? "jobs,accounts,finance,reviews";
	const triggerPath = process.env.ZMAIL_STRESS_TRIGGER_PATH;
	const navigationPaths = (
		process.env.ZMAIL_STRESS_PATHS ?? "/,/accounts,/runs,/finance"
	)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);

	const abortControllers = Array.from(
		{ length: clients },
		() => new AbortController(),
	);
	const errors: string[] = [];
	let navigationCount = 0;
	let eventCount = 0;

	console.log(
		`Stress run against ${baseUrl} with ${clients} WebSocket clients for ${durationMs}ms.`,
	);

	const wsRuns = abortControllers.map((controller) =>
		openWebSocketClient({
			url: buildWebSocketUrl({ baseUrl }),
			topics: topics.split(","),
			signal: controller.signal,
			onMessage: async (message) => {
				if (message.type === "runtime.event") {
					eventCount += 1;
				}
			},
		}).catch((error) => {
			if (!controller.signal.aborted) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}),
	);

	const startedAt = Date.now();
	const navigationLoop = (async () => {
		while (Date.now() - startedAt < durationMs) {
			for (const path of navigationPaths) {
				if (Date.now() - startedAt >= durationMs) {
					break;
				}
				const response = await fetch(`${baseUrl}${path}`, {
					headers: {
						"X-Requested-With": "zmail-stress",
					},
				}).catch((error) => {
					errors.push(error instanceof Error ? error.message : String(error));
					return null;
				});
				if (!response) {
					continue;
				}
				if (!response.ok) {
					errors.push(`navigation ${path} returned ${response.status}`);
				} else {
					const text = await response.text();
					if (!text.includes('id="app-main"')) {
						errors.push(`navigation ${path} did not return app-main fragment`);
					}
				}
				navigationCount += 1;
			}
			if (triggerPath) {
				await fetch(`${baseUrl}${triggerPath}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
					},
					body: "{}",
				}).catch((error) => {
					errors.push(error instanceof Error ? error.message : String(error));
				});
			}
			await sleep(250);
		}
	})();

	await navigationLoop;
	for (const controller of abortControllers) {
		controller.abort();
	}
	await Promise.allSettled(wsRuns);

	console.log("\nStress summary");
	console.log(`  WebSocket clients: ${clients}`);
	console.log(`  page navigations: ${navigationCount}`);
	console.log(`  events observed: ${eventCount}`);
	if (errors.length > 0) {
		console.error(`  errors: ${errors.length}`);
		for (const error of errors.slice(0, 10)) {
			console.error(`    - ${error}`);
		}
		process.exitCode = 1;
		return;
	}
	console.log("  errors: 0");
}

runCli(main, import.meta.url, "test-stress");
