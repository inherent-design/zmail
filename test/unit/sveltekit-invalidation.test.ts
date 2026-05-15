import { describe, expect, it } from "vitest";

import { zmailInvalidationKeySchema } from "#/lib/client-contract";

describe("SvelteKit invalidation keys", () => {
	it("accepts static and scoped keys", () => {
		expect(zmailInvalidationKeySchema.parse("zmail:home")).toBe("zmail:home");
		expect(zmailInvalidationKeySchema.parse("zmail:message:msg-1")).toBe(
			"zmail:message:msg-1",
		);
	});

	it("rejects removed island keys", () => {
		expect(() =>
			zmailInvalidationKeySchema.parse("island:finance.summary"),
		).toThrow();
	});
});
