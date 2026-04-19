import assert from "node:assert/strict";

import fc from "fast-check";
import { JSDOM } from "jsdom";

import {
	buildEventsUrl,
	normalizeTopics,
} from "#/public/client/core/realtime.js";
import { extractPartialMain } from "#/public/client/core/shell-nav.js";
import { runCli } from "#/scripts/_shared";

async function main() {
	console.log(
		"Running property tests for realtime and partial-navigation helpers.",
	);

	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.oneof(fc.string(), fc.constantFrom("", " ", "   "))),
			async (topics) => {
				const normalized = normalizeTopics(topics);
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
			fc.array(fc.string(), { minLength: 1, maxLength: 8 }),
			fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }),
			async (topics, cursor) => {
				const url = buildEventsUrl({ topics, cursor });
				const parsed = new URL(url, "http://127.0.0.1:56711");
				const normalized = normalizeTopics(topics);
				assert.equal(parsed.pathname, "/events");
				assert.equal(
					parsed.searchParams.get("topics"),
					normalized.length > 0 ? normalized.join(",") : null,
				);
				assert.equal(
					parsed.searchParams.get("cursor"),
					cursor == null ? null : String(cursor),
				);
			},
		),
		{ numRuns: 200 },
	);

	await fc.assert(
		fc.asyncProperty(fc.string(), async (content) => {
			const dom = new JSDOM("<!doctype html><html><body></body></html>");
			const fragment = `<div id="app-main" data-page="demo"><p>${content
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;")}</p></div>`;
			const node = extractPartialMain(fragment, new dom.window.DOMParser());
			assert.ok(node);
			assert.equal(node?.id, "app-main");
			assert.match(
				node?.textContent ?? "",
				new RegExp(content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
		}),
		{ numRuns: 200 },
	);

	console.log("Fuzz checks passed.");
}

runCli(main, import.meta.url, "test-fuzz");
