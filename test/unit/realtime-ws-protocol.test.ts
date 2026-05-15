import { describe, expect, it } from "vitest";

import { clientWsMessageSchema } from "#/server/realtime-ws";

describe("realtime WebSocket protocol", () => {
	it("accepts subscribe messages with nullable cursors", () => {
		expect(
			clientWsMessageSchema.parse({
				type: "subscribe",
				topics: ["jobs", "finance"],
				cursor: null,
			}),
		).toEqual({
			type: "subscribe",
			topics: ["jobs", "finance"],
			cursor: null,
		});
	});

	it("rejects command messages", () => {
		expect(() =>
			clientWsMessageSchema.parse({
				type: "mutate",
				path: "/rpc/accounts/acct-1/sync/full",
			}),
		).toThrow();
	});
});
