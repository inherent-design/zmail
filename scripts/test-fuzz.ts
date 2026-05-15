import assert from "node:assert/strict";

import fc from "fast-check";
import { runCli } from "#/scripts/_shared";
import { buildWebSocketUrl, normalizeWsTopics } from "#/scripts/_ws";

async function main() {
	console.log("Running property tests for WebSocket realtime helpers.");

	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.oneof(fc.string(), fc.constantFrom("", " ", "   "))),
			async (topics) => {
				const normalized = normalizeWsTopics(topics);
				assert.deepEqual(normalized, [...normalized].sort());
				assert.equal(new Set(normalized).size, normalized.length);
				for (const topic of normalized) {
					assert.equal(topic, topic.trim());
					assert.notEqual(topic.length, 0);
				}
			},
		),
		{ numRuns: 200 },
	);

	await fc.assert(
		fc.asyncProperty(
			fc.webUrl({ authoritySettings: { withIPv4: true } }),
			async (baseUrl) => {
				const url = buildWebSocketUrl({ baseUrl });
				const parsed = new URL(url);
				assert.equal(parsed.pathname, "/ws");
				assert.ok(parsed.protocol === "ws:" || parsed.protocol === "wss:");
			},
		),
		{ numRuns: 200 },
	);

	console.log("Fuzz checks passed.");
}

runCli(main, import.meta.url, "test-fuzz");
