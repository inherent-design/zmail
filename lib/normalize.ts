import { createHash } from "node:crypto";

import { convert } from "html-to-text";

export interface NormalizedBody {
	bodyTextNormalized: string;
	snippet: string;
	hasHtml: boolean;
	tokenEstimate: number;
}

export function normalizeWhitespace(value: string) {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\t/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ ]{2,}/g, " ")
		.trim();
}

export function stripQuotedReplyTail(value: string) {
	const patterns = [
		/\nOn .* wrote:\n[\s\S]*$/i,
		/\nFrom: .*\nSent: .*\nTo: .*\nSubject: .*$/is,
		/\n[-_]{5,}\s*Original Message\s*[-_]{5,}[\s\S]*$/i,
		/\nBegin forwarded message:\n[\s\S]*$/i,
	];

	let text = value;
	for (const pattern of patterns) {
		text = text.replace(pattern, "");
	}
	return text.trim();
}

export function normalizeBodyText(input: {
	text?: string | null;
	html?: string | null;
}): NormalizedBody {
	let text = input.text?.trim() ?? "";
	const hasHtml = Boolean(input.html?.trim());

	if (!text && input.html) {
		text = convert(input.html, {
			selectors: [
				{ selector: "a", options: { hideLinkHrefIfSameAsText: true } },
				{ selector: "img", format: "skip" },
			],
			wordwrap: false,
		});
	}

	text = normalizeWhitespace(stripQuotedReplyTail(text));
	const snippet = text.slice(0, 1200);

	return {
		bodyTextNormalized: text,
		snippet,
		hasHtml,
		tokenEstimate: Math.ceil(text.length / 4),
	};
}

export function normalizeSubjectRoot(subject: string | null | undefined) {
	const value = (subject ?? "").trim();
	if (!value) {
		return "(no-subject)";
	}
	return value
		.replace(/^((re|fw|fwd):\s*)+/gi, "")
		.trim()
		.toLowerCase();
}

export function buildThreadKey(input: {
	inReplyTo?: string | null;
	subject?: string | null;
	messageId: string;
}) {
	if (input.inReplyTo?.trim()) {
		return input.inReplyTo.trim();
	}
	return normalizeSubjectRoot(input.subject);
}

export function toAddressJson(
	list:
		| Array<{
				address?: string | null;
				name?: string | null;
		  }>
		| null
		| undefined,
) {
	return JSON.stringify(
		(list ?? []).map((entry) => ({
			address: entry.address ?? null,
			name: entry.name ?? null,
		})),
	);
}

export function hashRawMessage(value: string) {
	return createHash("sha1").update(value).digest("hex");
}

export function coerceReceivedAt(date: Date | null | undefined) {
	if (!date) {
		return null;
	}
	const time = date.getTime();
	if (Number.isNaN(time)) {
		return null;
	}
	return new Date(time).toISOString();
}
