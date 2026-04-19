import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createIslandRegistry,
	type RuntimeEvent,
} from "#/public/client/core/island-registry.js";

function stubDom() {
	const dom = new JSDOM(
		`<!DOCTYPE html>
		<html data-zmail-state-scope="org:local">
			<body>
				<main id="app-main" data-page="finance">
					<section data-zmail-island="finance.cashflow"></section>
					<section data-zmail-island="finance.summary"></section>
				</main>
			</body>
		</html>`,
		{ url: "http://localhost/finance" },
	);
	vi.stubGlobal("document", dom.window.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
	return dom;
}

describe("island registry", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns islands whose modules match runtime events", async () => {
		stubDom();
		const registry = createIslandRegistry({
			finance: async () => ({
				islands: {
					"finance.cashflow": {
						init() {},
						shouldRefresh(event: RuntimeEvent) {
							return (
								event.topic === "finance" &&
								event.eventType === "finance.ledger_rebuilt"
							);
						},
					},
					"finance.summary": {
						init() {},
						shouldRefresh() {
							return false;
						},
					},
				},
			}),
		});

		await registry.mount("finance", {});

		expect(
			registry.islandsForEvent({
				topic: "finance",
				eventType: "finance.ledger_rebuilt",
			}),
		).toEqual(["finance.cashflow"]);
		expect(
			registry.islandsForEvent({
				topic: "jobs",
				eventType: "job.updated",
			}),
		).toEqual([]);
	});
});
