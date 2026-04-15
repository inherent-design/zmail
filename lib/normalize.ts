import { createHash } from "node:crypto";

import { convert } from "html-to-text";

export type BodyExtractionStrategy =
	| "plain_text"
	| "html_to_text"
	| "quoted_tail_stripped"
	| "forwarded_split"
	| "fallback_empty"
	| "parse_error";

export interface NormalizedBody {
	bodyTextPrimary: string;
	bodyTextForwarded: string;
	bodyTextNormalized: string;
	snippet: string;
	hasHtml: boolean;
	tokenEstimate: number;
	bodyExtractionStrategy: BodyExtractionStrategy;
}

export interface ClassifierVisibleAttachment {
	filename: string | null;
	mime_type: string | null;
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
	];

	let text = value;
	for (const pattern of patterns) {
		text = text.replace(pattern, "");
	}
	return text.trim();
}

function convertHtmlToText(html: string) {
	return convert(html, {
		selectors: [
			{ selector: "a", options: { hideLinkHrefIfSameAsText: true } },
			{ selector: "img", format: "skip" },
		],
		wordwrap: false,
	});
}

function coerceTextLike(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(value).toString("utf8");
	}
	if (Array.isArray(value)) {
		return value
			.map((entry) => coerceTextLike(entry))
			.filter((entry) => entry.length > 0)
			.join("\n");
	}
	return "";
}

function splitForwardedContent(value: string) {
	const match =
		/(^|\n)(Begin forwarded message:|---------- Forwarded message ---------|Forwarded message)\s*\n?/i.exec(
			value,
		);
	if (!match || match.index === undefined) {
		return null;
	}

	const start = match.index + match[1].length;
	const end = start + match[2].length;
	return {
		primary: value.slice(0, start).trim(),
		forwarded: value.slice(end).trim(),
	};
}

function buildNormalizedBodyText(
	bodyTextPrimary: string,
	bodyTextForwarded: string,
) {
	if (bodyTextPrimary && bodyTextForwarded) {
		return `${bodyTextPrimary}\n\n[Forwarded content]\n${bodyTextForwarded}`;
	}
	return bodyTextPrimary || bodyTextForwarded || "";
}

function buildSnippet(bodyTextPrimary: string, bodyTextForwarded: string) {
	return (bodyTextPrimary || bodyTextForwarded || "").slice(0, 1200);
}

function buildTokenEstimate(value: string) {
	return Math.ceil(value.length / 4);
}

function compareNullableText(left: string | null, right: string | null) {
	return (left ?? "").localeCompare(right ?? "");
}

export function normalizeClassifierVisibleAttachments(
	attachments: Array<{
		filename?: string | null;
		mimeType?: string | null;
		mime_type?: string | null;
	}>,
): ClassifierVisibleAttachment[] {
	return attachments
		.map((attachment) => ({
			filename: attachment.filename ?? null,
			mime_type: attachment.mime_type ?? attachment.mimeType ?? null,
		}))
		.sort((left, right) => {
			const filenameOrder = compareNullableText(left.filename, right.filename);
			if (filenameOrder !== 0) {
				return filenameOrder;
			}
			return compareNullableText(left.mime_type, right.mime_type);
		});
}

export function buildContentSha256(input: {
	senderAddress: string | null;
	subject: string | null;
	receivedAt: string | null;
	bodyTextNormalized: string;
	attachments: Array<{
		filename?: string | null;
		mimeType?: string | null;
		mime_type?: string | null;
	}>;
}) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				sender_address: input.senderAddress ?? null,
				subject: input.subject ?? null,
				received_at: input.receivedAt ?? null,
				body_text_normalized: input.bodyTextNormalized,
				attachments: normalizeClassifierVisibleAttachments(input.attachments),
			}),
		)
		.digest("hex");
}

export function normalizeBodyText(input: {
	text?: unknown;
	html?: unknown;
}): NormalizedBody {
	let text = coerceTextLike(input.text).trim();
	const html = coerceTextLike(input.html).trim();
	const hasHtml = html.length > 0;
	let source: "plain_text" | "html_to_text" | "fallback_empty" = "plain_text";

	if (text) {
		source = "plain_text";
	} else if (html) {
		text = convertHtmlToText(html);
		source = "html_to_text";
	} else {
		source = "fallback_empty";
	}

	const normalizedCandidate = normalizeWhitespace(text);
	const forwardedSplit = splitForwardedContent(normalizedCandidate);

	if (forwardedSplit) {
		const strippedPrimary = stripQuotedReplyTail(forwardedSplit.primary);
		const bodyTextPrimary = normalizeWhitespace(strippedPrimary);
		const bodyTextForwarded = normalizeWhitespace(forwardedSplit.forwarded);
		const bodyTextNormalized = buildNormalizedBodyText(
			bodyTextPrimary,
			bodyTextForwarded,
		);

		return {
			bodyTextPrimary,
			bodyTextForwarded,
			bodyTextNormalized,
			snippet: buildSnippet(bodyTextPrimary, bodyTextForwarded),
			hasHtml,
			tokenEstimate: buildTokenEstimate(bodyTextNormalized),
			bodyExtractionStrategy: bodyTextForwarded
				? "forwarded_split"
				: strippedPrimary !== forwardedSplit.primary
					? "quoted_tail_stripped"
					: source,
		};
	}

	const strippedText = stripQuotedReplyTail(normalizedCandidate);
	const bodyTextPrimary = normalizeWhitespace(strippedText);
	const bodyTextForwarded = "";
	const bodyTextNormalized = bodyTextPrimary;

	return {
		bodyTextPrimary,
		bodyTextForwarded,
		bodyTextNormalized,
		snippet: buildSnippet(bodyTextPrimary, bodyTextForwarded),
		hasHtml,
		tokenEstimate: buildTokenEstimate(bodyTextNormalized),
		bodyExtractionStrategy:
			strippedText !== normalizedCandidate ? "quoted_tail_stripped" : source,
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
