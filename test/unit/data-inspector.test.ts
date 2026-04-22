import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initDataInspectors } from "#/public/client/components/data-inspector.js";
import { DataInspector } from "#/server/ui/primitives";

describe("DataInspector", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders path controls and redacts sensitive JSON values", () => {
		const html = String(
			DataInspector({
				kind: "job",
				id: "job-1",
				status: "queued",
				value: {
					accessToken: "secret-token",
					accountNumber: "123456789012",
					memo: "Account 9999 8888 7777 is hidden.",
					occurredAt: "2026-04-22",
					nested: { safe: "visible" },
				},
			}),
		);

		expect(html).toContain('data-copy-path="$.nested.safe"');
		expect(html).toContain("visible");
		expect(html).toContain("[redacted]");
		expect(html).toContain("[redacted-number]");
		expect(html).toContain("2026-04-22");
		expect(html).not.toContain("secret-token");
		expect(html).not.toContain("123456789012");
		expect(html).not.toContain("9999 8888 7777");
	});

	it("renders stable tree keys and safe JSON for circular and bigint values", () => {
		const value: Record<string, unknown> = {
			id: 42n,
			nested: { "odd.key": true },
		};
		value.self = value;

		const html = String(
			DataInspector({
				kind: "job",
				id: "job-1",
				value,
			}),
		);

		expect(html).toContain('data-copy-path="$.self"');
		expect(html).toContain("42");
		expect(html).toContain("[circular]");
		expect(html).toContain('data-zmail-state-key="job:job-1:tree:$"');
		expect(html).toContain('data-zmail-state-key="job:job-1:tree:$.nested"');
		expect(html).toContain('data-copy-path="$.nested[&quot;odd.key&quot;]"');
	});

	it("copies the clicked JSON path instead of always copying root", async () => {
		const dom = new JSDOM(`
			<details class="data-inspector">
				<span data-copy-status></span>
				<button type="button" data-copy-path="$.nested.safe">Copy path</button>
				<details class="data-inspector-raw">
					<pre data-json-path="$">{"nested":{"safe":true}}</pre>
				</details>
			</details>
		`);
		const writeText = vi.fn(async () => {});
		vi.stubGlobal("navigator", {
			clipboard: { writeText },
		});
		const cleanup = initDataInspectors(dom.window.document);

		dom.window.document
			.querySelector("[data-copy-path]")
			?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		await Promise.resolve();

		expect(writeText).toHaveBeenCalledWith("$.nested.safe");
		expect(
			dom.window.document.querySelector("[data-copy-status]")?.textContent,
		).toBe("Copied.");
		cleanup();
	});

	it("reports unavailable clipboard without toggling inspector details", async () => {
		const dom = new JSDOM(`
			<details class="data-inspector" open>
				<summary>
					Job
					<button type="button" data-copy-path="$.id">Copy path</button>
				</summary>
				<span data-copy-status></span>
				<details class="data-inspector-raw">
					<pre data-json-path="$">{"id":"job-1"}</pre>
				</details>
			</details>
		`);
		vi.stubGlobal("navigator", {});
		const cleanup = initDataInspectors(dom.window.document);
		const details = dom.window.document.querySelector("details");
		const event = new dom.window.MouseEvent("click", {
			bubbles: true,
			cancelable: true,
		});

		const dispatchResult =
			dom.window.document
				.querySelector("[data-copy-path]")
				?.dispatchEvent(event) ?? true;
		await Promise.resolve();

		expect(dispatchResult).toBe(false);
		expect(details?.open).toBe(true);
		expect(
			dom.window.document.querySelector("[data-copy-status]")?.textContent,
		).toBe("Clipboard API is unavailable.");
		cleanup();
	});
});
