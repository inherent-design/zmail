import { describe, expect, it } from "vitest";

import {
	buildThreadKey,
	coerceReceivedAt,
	hashRawMessage,
	normalizeBodyText,
	normalizeSubjectRoot,
	normalizeWhitespace,
	stripQuotedReplyTail,
	toAddressJson,
} from "#/lib/normalize";

describe("normalize", () => {
	it("normalizes whitespace", () => {
		expect(normalizeWhitespace("a\r\n\r\n\r\nb\t\tc  d")).toBe("a\n\nb c d");
	});

	it("strips quoted reply tails", () => {
		const value = [
			"Top line",
			"",
			"On Thu, Jan 01, 2026 at 10:00 AM Billing Team wrote:",
			"> older text",
		].join("\n");
		expect(stripQuotedReplyTail(value)).toBe("Top line");
	});

	it("falls back to html conversion and truncates snippet", () => {
		const normalized = normalizeBodyText({
			html: '<div><p>Hello <strong>world</strong></p><img src="x" /></div>',
		});

		expect(normalized.bodyTextNormalized).toContain("Hello world");
		expect(normalized.hasHtml).toBe(true);
		expect(normalized.snippet).toBe(normalized.bodyTextNormalized);
		expect(normalized.tokenEstimate).toBe(
			Math.ceil(normalized.bodyTextNormalized.length / 4),
		);
	});

	it("normalizes subject roots", () => {
		expect(normalizeSubjectRoot(" Re: Fwd: Example ")).toBe("example");
		expect(normalizeSubjectRoot("")).toBe("(no-subject)");
		expect(normalizeSubjectRoot(null)).toBe("(no-subject)");
	});

	it("builds thread key with in-reply-to precedence", () => {
		expect(
			buildThreadKey({
				inReplyTo: "<parent@example.com>",
				subject: "Re: Example",
				messageId: "<child@example.com>",
			}),
		).toBe("<parent@example.com>");

		expect(
			buildThreadKey({
				inReplyTo: null,
				subject: "Re: Example",
				messageId: "<child@example.com>",
			}),
		).toBe("example");
	});

	it("serializes address lists", () => {
		expect(
			toAddressJson([
				{ address: "a@example.com", name: "A" },
				{ address: undefined, name: undefined },
			]),
		).toBe(
			JSON.stringify([
				{ address: "a@example.com", name: "A" },
				{ address: null, name: null },
			]),
		);
	});

	it("hashes raw messages deterministically", () => {
		expect(hashRawMessage("hello")).toBe(hashRawMessage("hello"));
		expect(hashRawMessage("hello")).not.toBe(hashRawMessage("world"));
	});

	it("coerces valid dates and rejects invalid dates", () => {
		expect(coerceReceivedAt(new Date("2026-01-01T00:00:00.000Z"))).toBe(
			"2026-01-01T00:00:00.000Z",
		);
		expect(coerceReceivedAt(new Date("bad"))).toBeNull();
		expect(coerceReceivedAt(null)).toBeNull();
	});
});
