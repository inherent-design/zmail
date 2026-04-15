import { describe, expect, it } from "vitest";

import {
	buildContentSha256,
	buildThreadKey,
	coerceReceivedAt,
	hashRawMessage,
	normalizeBodyText,
	normalizeClassifierVisibleAttachments,
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

	it("falls back to html conversion and reports the html strategy", () => {
		const normalized = normalizeBodyText({
			html: '<div><p>Hello <strong>world</strong></p><img src="x" /></div>',
		});

		expect(normalized.bodyTextPrimary).toContain("Hello world");
		expect(normalized.bodyTextForwarded).toBe("");
		expect(normalized.bodyTextNormalized).toContain("Hello world");
		expect(normalized.hasHtml).toBe(true);
		expect(normalized.snippet).toBe(normalized.bodyTextNormalized);
		expect(normalized.tokenEstimate).toBe(
			Math.ceil(normalized.bodyTextNormalized.length / 4),
		);
		expect(normalized.bodyExtractionStrategy).toBe("html_to_text");
	});

	it("coerces byte arrays and nested arrays before normalization", () => {
		const normalized = normalizeBodyText({
			text: [new Uint8Array(Buffer.from("Primary body")), ["Nested line"]],
		});

		expect(normalized.bodyTextPrimary).toBe("Primary body\nNested line");
		expect(normalized.bodyTextNormalized).toBe("Primary body\nNested line");
		expect(normalized.bodyExtractionStrategy).toBe("plain_text");
	});

	it("splits forwarded content and preserves the forwarded body", () => {
		const normalized = normalizeBodyText({
			text: [
				"Top line",
				"",
				"Begin forwarded message:",
				"From: Accounts <billing@example.com>",
				"Subject: Quarterly statement",
				"",
				"Forwarded body",
			].join("\n"),
		});

		expect(normalized.bodyTextPrimary).toBe("Top line");
		expect(normalized.bodyTextForwarded).toContain(
			"Subject: Quarterly statement",
		);
		expect(normalized.bodyTextNormalized).toBe(
			[
				"Top line",
				"",
				"[Forwarded content]",
				"From: Accounts <billing@example.com>",
				"Subject: Quarterly statement",
				"",
				"Forwarded body",
			].join("\n"),
		);
		expect(normalized.bodyExtractionStrategy).toBe("forwarded_split");
	});

	it("strips quoted tails only from the primary side of a forwarded split", () => {
		const normalized = normalizeBodyText({
			text: [
				"Reply up top",
				"",
				"On Thu, Jan 01, 2026 at 10:00 AM Billing Team wrote:",
				"> prior reply text",
				"",
				"---------- Forwarded message ---------",
				"Forwarded message",
				"",
				"On Mon, Dec 29, 2025 at 8:00 AM Ops wrote:",
				"> forwarded history should remain",
			].join("\n"),
		});

		expect(normalized.bodyTextPrimary).toBe("Reply up top");
		expect(normalized.bodyTextForwarded).toContain(
			"On Mon, Dec 29, 2025 at 8:00 AM Ops wrote:",
		);
		expect(normalized.bodyExtractionStrategy).toBe("forwarded_split");
	});

	it("derives snippets from primary first and forwarded second", () => {
		expect(
			normalizeBodyText({
				text: ["Primary first", "", "Forwarded message", "Later body"].join(
					"\n",
				),
			}).snippet,
		).toBe("Primary first");
		expect(
			normalizeBodyText({
				text: ["Forwarded message", "Forwarded only"].join("\n"),
			}).snippet,
		).toBe("Forwarded only");
	});

	it("falls back to quoted-tail stripping when a forwarded marker has no forwarded body", () => {
		const normalized = normalizeBodyText({
			text: [
				"Reply up top",
				"",
				"On Thu, Jan 01, 2026 at 10:00 AM Billing Team wrote:",
				"> prior reply text",
				"",
				"Forwarded message",
			].join("\n"),
		});

		expect(normalized.bodyTextPrimary).toBe("Reply up top");
		expect(normalized.bodyTextForwarded).toBe("");
		expect(normalized.bodyExtractionStrategy).toBe("quoted_tail_stripped");
	});

	it("falls back to the original source strategy when a forwarded marker has no forwarded body and no quoted tail", () => {
		const normalized = normalizeBodyText({
			text: ["Standalone note", "", "Forwarded message"].join("\n"),
		});

		expect(normalized.bodyTextPrimary).toBe("Standalone note");
		expect(normalized.bodyTextForwarded).toBe("");
		expect(normalized.bodyExtractionStrategy).toBe("plain_text");
	});

	it("returns an empty normalized body when the text is only a forwarded marker", () => {
		const normalized = normalizeBodyText({
			text: "Forwarded message",
		});

		expect(normalized.bodyTextPrimary).toBe("");
		expect(normalized.bodyTextForwarded).toBe("");
		expect(normalized.bodyTextNormalized).toBe("");
		expect(normalized.snippet).toBe("");
	});

	it("selects the expected extraction strategy precedence", () => {
		expect(
			normalizeBodyText({ text: "Plain text" }).bodyExtractionStrategy,
		).toBe("plain_text");
		expect(
			normalizeBodyText({
				text: [
					"Reply up top",
					"",
					"On Thu, Jan 01, 2026 at 10:00 AM Billing Team wrote:",
					"> prior reply text",
				].join("\n"),
			}).bodyExtractionStrategy,
		).toBe("quoted_tail_stripped");
		expect(
			normalizeBodyText({ html: "<p>html only</p>" }).bodyExtractionStrategy,
		).toBe("html_to_text");
		expect(normalizeBodyText({}).bodyExtractionStrategy).toBe("fallback_empty");
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

	it("normalizes classifier-visible attachments and hashes classifier inputs deterministically", () => {
		const attachments = [
			{ filename: "b.pdf", mime_type: "application/pdf" },
			{ filename: "a.txt", mime_type: "text/plain" },
		];
		expect(normalizeClassifierVisibleAttachments(attachments)).toEqual([
			{ filename: "a.txt", mime_type: "text/plain" },
			{ filename: "b.pdf", mime_type: "application/pdf" },
		]);

		const firstHash = buildContentSha256({
			senderAddress: "sender@example.com",
			subject: "Subject",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyTextNormalized: "Normalized body",
			attachments,
		});
		const reorderedHash = buildContentSha256({
			senderAddress: "sender@example.com",
			subject: "Subject",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyTextNormalized: "Normalized body",
			attachments: [...attachments].reverse(),
		});
		const changedAttachmentHash = buildContentSha256({
			senderAddress: "sender@example.com",
			subject: "Subject",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyTextNormalized: "Normalized body",
			attachments: [
				{ filename: "b.pdf", mime_type: "application/pdf" },
				{ filename: "renamed.txt", mime_type: "text/plain" },
			],
		});
		const changedBodyHash = buildContentSha256({
			senderAddress: "sender@example.com",
			subject: "Subject",
			receivedAt: "2026-01-01T00:00:00.000Z",
			bodyTextNormalized: "Changed body",
			attachments,
		});

		expect(firstHash).toBe(reorderedHash);
		expect(firstHash).not.toBe(changedAttachmentHash);
		expect(firstHash).not.toBe(changedBodyHash);
	});

	it("sorts classifier-visible attachments by mime type when filenames match", () => {
		expect(
			normalizeClassifierVisibleAttachments([
				{ filename: "same-name", mime_type: "text/plain" },
				{ filename: "same-name", mime_type: "application/pdf" },
			]),
		).toEqual([
			{ filename: "same-name", mime_type: "application/pdf" },
			{ filename: "same-name", mime_type: "text/plain" },
		]);
	});

	it("hashes nullable classifier-visible inputs deterministically", () => {
		expect(
			buildContentSha256({
				senderAddress: null,
				subject: null,
				receivedAt: null,
				bodyTextNormalized: "",
				attachments: [{ filename: null, mime_type: null }],
			}),
		).toBe(
			buildContentSha256({
				senderAddress: null,
				subject: null,
				receivedAt: null,
				bodyTextNormalized: "",
				attachments: [{ filename: null, mime_type: null }],
			}),
		);
	});

	it("sorts nullable attachment values deterministically", () => {
		expect(
			normalizeClassifierVisibleAttachments([
				{ filename: null, mime_type: "text/plain" },
				{ filename: null, mime_type: null },
			]),
		).toEqual([
			{ filename: null, mime_type: null },
			{ filename: null, mime_type: "text/plain" },
		]);
	});

	it("coerces valid dates and rejects invalid dates", () => {
		expect(coerceReceivedAt(new Date("2026-01-01T00:00:00.000Z"))).toBe(
			"2026-01-01T00:00:00.000Z",
		);
		expect(coerceReceivedAt(new Date("bad"))).toBeNull();
		expect(coerceReceivedAt(null)).toBeNull();
	});
});
