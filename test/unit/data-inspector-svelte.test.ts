import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import DataInspector from "#/src/lib/components/DataInspector.svelte";

describe("DataInspector.svelte", () => {
	it("renders structured data without zmail island attributes", () => {
		const { body } = render(DataInspector, {
			props: { title: "Manifest", value: { status: "ready", count: 2 } },
		});

		expect(body).toContain("Manifest");
		expect(body).toContain('"status": "ready"');
		expect(body).not.toContain("data-zmail-island");
	});
});
