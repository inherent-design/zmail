import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	captureGenericState,
	createIslandRegistry,
	type RuntimeEvent,
	restoreGenericState,
} from "#/public/client/core/island-registry.js";
import {
	ACCOUNT_DETAIL_ISLAND_IDS,
	ACCOUNTS_ISLAND_IDS,
	FINANCE_ISLAND_IDS,
	HOME_ISLAND_IDS,
	ISLAND_DEFINITIONS,
	IslandFrame,
	MESSAGE_DETAIL_ISLAND_IDS,
	PROFILE_ISLAND_IDS,
	REVIEW_ISLAND_IDS,
	RUNS_ISLAND_IDS,
} from "#/server/ui";

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

	it("defines every rendered island id", () => {
		const renderedIds = [
			...HOME_ISLAND_IDS,
			...ACCOUNTS_ISLAND_IDS,
			...ACCOUNT_DETAIL_ISLAND_IDS,
			...MESSAGE_DETAIL_ISLAND_IDS,
			...REVIEW_ISLAND_IDS,
			...FINANCE_ISLAND_IDS,
			...PROFILE_ISLAND_IDS,
			...RUNS_ISLAND_IDS,
		];
		for (const id of renderedIds) {
			expect(ISLAND_DEFINITIONS[id]).toMatchObject({
				id,
				mode: expect.any(String),
				page: expect.any(String),
				fragmentUrl: expect.any(String),
				statePolicy: expect.objectContaining({
					restoreOnSwap: expect.any(Boolean),
				}),
				fallback: expect.stringMatching(/^(none|main)$/),
			});
		}
		expect(() => IslandFrame({ id: "missing.island", children: null })).toThrow(
			"Missing island definition",
		);
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

	it("captures and restores generic island state", () => {
		const dom = new JSDOM(
			`<!DOCTYPE html>
			<html>
				<body>
					<section data-zmail-island="review.queue">
						<textarea name="override">old</textarea>
						<input name="flag" type="checkbox" value="yes">
						<select name="status" multiple>
							<option value="ready">Ready</option>
							<option value="blocked">Blocked</option>
						</select>
						<div data-zmail-scroll-key="ledger"></div>
						<details data-zmail-state-key="row-1"><summary>Row</summary></details>
						<button data-zmail-sort-key="date" aria-sort="ascending"></button>
					</section>
				</body>
			</html>`,
			{ url: "http://localhost/review" },
		);
		vi.stubGlobal("document", dom.window.document);
		vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
		const root = dom.window.document.querySelector("[data-zmail-island]");
		if (!root) {
			throw new Error("root missing");
		}
		const textarea = root.querySelector("textarea");
		if (!textarea) {
			throw new Error("textarea missing");
		}
		textarea.value = "draft text";
		textarea.focus();
		textarea.setSelectionRange(2, 7, "forward");
		const checkbox = root.querySelector("input");
		if (!checkbox) {
			throw new Error("checkbox missing");
		}
		checkbox.checked = true;
		const select = root.querySelector("select");
		if (!select) {
			throw new Error("select missing");
		}
		select.options[1].selected = true;
		const scroller = root.querySelector("[data-zmail-scroll-key]");
		if (!scroller) {
			throw new Error("scroller missing");
		}
		Object.defineProperty(scroller, "scrollTop", { value: 42, writable: true });
		const details = root.querySelector("details");
		if (!details) {
			throw new Error("details missing");
		}
		details.open = true;

		const state = captureGenericState(root);
		root.innerHTML = `
			<textarea name="override">server</textarea>
			<input name="flag" type="checkbox" value="yes">
			<select name="status" multiple>
				<option value="ready">Ready</option>
				<option value="blocked">Blocked</option>
			</select>
			<div data-zmail-scroll-key="ledger"></div>
			<details data-zmail-state-key="row-1"><summary>Row</summary></details>
			<button data-zmail-sort-key="date" aria-sort="descending"></button>
		`;
		restoreGenericState(root, state);

		const restoredTextarea = root.querySelector("textarea");
		const restoredCheckbox = root.querySelector("input");
		const restoredSelect = root.querySelector("select");
		const restoredScroller = root.querySelector("[data-zmail-scroll-key]");
		const restoredDetails = root.querySelector("details");
		const restoredSort = root.querySelector("[data-zmail-sort-key]");
		expect(restoredTextarea?.value).toBe("draft text");
		expect(restoredTextarea?.selectionStart).toBe(2);
		expect(restoredTextarea?.selectionEnd).toBe(7);
		expect(restoredCheckbox?.checked).toBe(true);
		expect(
			Array.from(restoredSelect?.selectedOptions ?? []).map(
				(option) => option.value,
			),
		).toEqual(["blocked"]);
		expect(restoredScroller?.scrollTop).toBe(42);
		expect(restoredDetails?.open).toBe(true);
		expect(restoredSort?.getAttribute("aria-sort")).toBe("ascending");
		expect(dom.window.document.activeElement).toBe(restoredTextarea);
	});

	it("restores finance details state by stable row keys across swaps", () => {
		const dom = new JSDOM(
			`<!DOCTYPE html>
			<html>
				<body>
					<section data-zmail-island="finance.imports">
						<details data-zmail-state-key="finance-import-document:doc-1"><summary>Doc 1</summary></details>
						<details data-zmail-state-key="finance-import-transaction:tx-1"><summary>Tx 1</summary></details>
					</section>
				</body>
			</html>`,
			{ url: "http://localhost/finance?tab=imports" },
		);
		vi.stubGlobal("document", dom.window.document);
		vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
		const root = dom.window.document.querySelector("[data-zmail-island]");
		if (!root) {
			throw new Error("root missing");
		}
		const transaction = root.querySelector(
			'[data-zmail-state-key="finance-import-transaction:tx-1"]',
		);
		if (!(transaction instanceof dom.window.HTMLDetailsElement)) {
			throw new Error("transaction details missing");
		}
		transaction.open = true;

		const state = captureGenericState(root);
		root.innerHTML = `
			<details data-zmail-state-key="finance-import-transaction:tx-1"><summary>Tx 1</summary></details>
			<details data-zmail-state-key="finance-import-document:doc-1"><summary>Doc 1</summary></details>
		`;
		restoreGenericState(root, state);

		const restoredTransaction = root.querySelector(
			'[data-zmail-state-key="finance-import-transaction:tx-1"]',
		);
		const restoredDocument = root.querySelector(
			'[data-zmail-state-key="finance-import-document:doc-1"]',
		);
		expect(
			restoredTransaction instanceof dom.window.HTMLDetailsElement
				? restoredTransaction.open
				: false,
		).toBe(true);
		expect(
			restoredDocument instanceof dom.window.HTMLDetailsElement
				? restoredDocument.open
				: true,
		).toBe(false);
	});

	it("maps account job events to account detail islands", async () => {
		const { accountDetailIslandHints } = await import(
			"#/public/client/pages/account-detail.js"
		);

		expect(
			accountDetailIslandHints(
				{
					topic: "account:acct-1",
					eventType: "job.updated",
					payload: {
						scopeType: "account",
						scopeId: "acct-1",
						lane: "sync",
					},
				},
				"acct-1",
			),
		).toEqual(["account.lanes", "account.recent-jobs", "account.mailbox-sync"]);
		expect(
			accountDetailIslandHints(
				{
					topic: "account:acct-2",
					eventType: "job.updated",
					payload: {
						scopeType: "account",
						scopeId: "acct-2",
						lane: "root_llm",
					},
				},
				"acct-1",
			),
		).toEqual([]);
	});

	it("maps page events to known island ids", async () => {
		const knownIds = new Set(Object.keys(ISLAND_DEFINITIONS));
		const { accountsIslandHints } = await import(
			"#/public/client/pages/accounts.js"
		);
		const { messageDetailIslandHints } = await import(
			"#/public/client/pages/message-detail.js"
		);
		const { reviewIslandHints } = await import(
			"#/public/client/pages/review.js"
		);
		const { profileIslandHints } = await import(
			"#/public/client/pages/profiles.js"
		);
		const samples = [
			accountsIslandHints({ topic: "accounts", eventType: "account.updated" }),
			messageDetailIslandHints({
				topic: "reviews",
				eventType: "review.updated",
			}),
			reviewIslandHints({ topic: "reviews", eventType: "review.updated" }),
			profileIslandHints(
				{
					topic: "jobs",
					eventType: "job.updated",
					payload: { status: "complete", scopeId: "acct-1" },
				},
				"acct-1",
			),
		];
		for (const ids of samples) {
			for (const id of ids) {
				expect(knownIds.has(id)).toBe(true);
			}
		}
	});

	it("maps finance events to the active tab island only", async () => {
		const { financeIslandHints } = await import(
			"#/public/client/pages/finance.js"
		);

		expect(
			financeIslandHints(
				{
					topic: "finance",
					eventType: "finance.ledger_rebuilt",
					payload: {},
				},
				"mappings",
			),
		).toEqual([
			"finance.summary",
			"finance.cashflow",
			"finance.categories",
			"finance.mappings",
			"finance.lanes",
		]);
		expect(
			financeIslandHints(
				{
					topic: "finance",
					eventType: "review_classifier.completed",
					payload: {},
				},
				"mappings",
			),
		).toEqual(["finance.lanes"]);
	});
});
