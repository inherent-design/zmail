import { setTimeout as sleep } from "node:timers/promises";

import { runCli } from "#/scripts/_shared";
import { buildWebSocketUrl, openWebSocketClient } from "#/scripts/_ws";

async function main() {
	const baseUrl = process.env.ZMAIL_BASE_URL ?? "http://127.0.0.1:56711";
	const clients = Number.parseInt(process.env.ZMAIL_WS_CLIENTS ?? "10", 10);
	const durationMs = Number.parseInt(
		process.env.ZMAIL_WS_DURATION_MS ?? "15000",
		10,
	);
	const topics = process.env.ZMAIL_WS_TOPICS ?? "jobs";
	const triggerPath = process.env.ZMAIL_WS_TRIGGER_PATH;
	const triggerIntervalMs = Number.parseInt(
		process.env.ZMAIL_WS_TRIGGER_INTERVAL_MS ?? "2000",
		10,
	);
	const url = buildWebSocketUrl({ baseUrl });

	let totalEvents = 0;
	let heartbeats = 0;
	let firstEventLatencyTotal = 0;
	const firstEventSeen = new Set<number>();
	const abortControllers = Array.from(
		{ length: clients },
		() => new AbortController(),
	);

	console.log(
		`Opening ${clients} WebSocket clients against ${url} for ${durationMs}ms.`,
	);
	if (!triggerPath) {
		console.log(
			"No trigger path configured. Set ZMAIL_WS_TRIGGER_PATH to generate job churn during the run.",
		);
	}

	const startedAt = Date.now();
	const clientRuns = abortControllers.map((controller, index) =>
		openWebSocketClient({
			url,
			topics: topics.split(","),
			signal: controller.signal,
			onMessage: async (message) => {
				if (message.type === "runtime.event") {
					totalEvents += 1;
				}
				if (message.type === "heartbeat") {
					heartbeats += 1;
				}
				if (!firstEventSeen.has(index)) {
					firstEventSeen.add(index);
					firstEventLatencyTotal += Date.now() - startedAt;
				}
			},
		}).catch((error) => {
			if (!controller.signal.aborted) {
				throw error;
			}
		}),
	);

	let triggerTimer: NodeJS.Timeout | undefined;
	if (triggerPath) {
		triggerTimer = setInterval(() => {
			void fetch(`${baseUrl}${triggerPath}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: "{}",
			}).catch(() => {});
		}, triggerIntervalMs);
	}

	await sleep(durationMs);
	for (const controller of abortControllers) {
		controller.abort();
	}
	if (triggerTimer) {
		clearInterval(triggerTimer);
	}
	await Promise.allSettled(clientRuns);

	const firstLatencyAverage =
		firstEventSeen.size > 0
			? Math.round(firstEventLatencyTotal / firstEventSeen.size)
			: 0;

	console.log("\nWebSocket benchmark summary");
	console.log(`  clients: ${clients}`);
	console.log(`  runtime events: ${totalEvents}`);
	console.log(`  heartbeats: ${heartbeats}`);
	console.log(`  first-message avg latency: ${firstLatencyAverage}ms`);
}

runCli(main, import.meta.url, "bench-ws");
