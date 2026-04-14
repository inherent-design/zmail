import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import { rawEmlPath } from "#/lib/config";
import {
	buildThreadKey,
	coerceReceivedAt,
	normalizeBodyText,
	toAddressJson,
} from "#/lib/normalize";

export interface ImapConnectOptions {
	email: string;
	accessToken: string;
	mailbox?: string;
}

export function createImapClient(options: ImapConnectOptions) {
	return new ImapFlow({
		host: "imap.gmail.com",
		port: 993,
		secure: true,
		auth: {
			user: options.email,
			accessToken: options.accessToken,
		},
		logger: false,
	});
}

export interface FetchedMessage {
	uid: number;
	gmMsgId: string;
	gmThrid: string;
	internalDate: Date;
	raw: Buffer;
	sha256: string;
}

function mapFetchedMessage(
	msg: {
		uid: number;
		source?: Buffer;
		internalDate?: Date | string;
		emailId?: string;
		threadId?: string;
	} & Record<string, unknown>,
) {
	const raw = msg.source;
	if (!raw) {
		return null;
	}

	const sha256 = createHash("sha256").update(raw).digest("hex");
	const gmMsgId = String(msg.emailId ?? msg["x-gm-msgid"] ?? "");
	const gmThrid = String(msg.threadId ?? msg["x-gm-thrid"] ?? "");

	return {
		uid: msg.uid,
		gmMsgId,
		gmThrid,
		internalDate:
			msg.internalDate instanceof Date
				? msg.internalDate
				: typeof msg.internalDate === "string"
					? new Date(msg.internalDate)
					: new Date(),
		raw,
		sha256,
	} satisfies FetchedMessage;
}

export async function fetchMessageWindow(
	client: ImapFlow,
	startUid: number,
	windowSize: number,
): Promise<FetchedMessage[]> {
	const messages: FetchedMessage[] = [];
	const range = `${startUid}:*`;

	let count = 0;
	for await (const msg of client.fetch(
		range,
		{
			uid: true,
			source: true,
			internalDate: true,
			threadId: true,
			labels: true,
			headers: false,
		},
		{ uid: true },
	)) {
		if (count >= windowSize) {
			break;
		}

		const mapped = mapFetchedMessage(
			msg as typeof msg & Record<string, unknown>,
		);
		if (!mapped) {
			continue;
		}

		messages.push(mapped);
		count += 1;
	}

	return messages;
}

export async function fetchMessageRange(
	client: ImapFlow,
	startUid: number,
	endUid: number,
): Promise<FetchedMessage[]> {
	if (endUid < startUid) {
		return [];
	}

	const messages: FetchedMessage[] = [];
	for await (const msg of client.fetch(
		`${startUid}:${endUid}`,
		{
			uid: true,
			source: true,
			internalDate: true,
			threadId: true,
			labels: true,
			headers: false,
		},
		{ uid: true },
	)) {
		const mapped = mapFetchedMessage(
			msg as typeof msg & Record<string, unknown>,
		);
		if (mapped) {
			messages.push(mapped);
		}
	}

	messages.sort((left, right) => left.uid - right.uid);
	return messages;
}

export async function fetchMessageWindowDescending(
	client: ImapFlow,
	endUid: number,
	windowSize: number,
): Promise<FetchedMessage[]> {
	const startUid = Math.max(1, endUid - windowSize + 1);
	const messages = await fetchMessageRange(client, startUid, endUid);
	return messages.sort((left, right) => right.uid - left.uid);
}

export function writeRawEml(
	accountId: string,
	remoteMessageId: string,
	raw: Buffer,
) {
	const path = rawEmlPath(accountId, remoteMessageId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, raw);
	return path;
}

export interface ParsedImapMessage {
	id: string;
	messageId: string;
	threadKey: string;
	receivedAt: string | null;
	senderName: string | null;
	senderAddress: string | null;
	toJson: string;
	ccJson: string;
	subject: string | null;
	inReplyTo: string | null;
	bodyTextNormalized: string;
	snippet: string;
	attachmentCount: number;
	hasHtml: number;
	parseStatus: string;
	tokenEstimate: number;
	contentSha256: string;
	attachments: Array<{
		id: string;
		filename: string | null;
		mimeType: string | null;
		sizeBytes: number;
		contentId: string | null;
		isInline: number;
	}>;
}

export async function parseRawMessage(
	raw: Buffer,
	sha256: string,
): Promise<ParsedImapMessage> {
	const { randomUUID } = await import("node:crypto");

	try {
		const parsed = await simpleParser(
			raw as unknown as Buffer<ArrayBufferLike> & string,
		);
		const messageId =
			typeof parsed.messageId === "string"
				? parsed.messageId
				: `<${randomUUID()}@unknown>`;
		const inReplyTo =
			typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : null;

		const body = normalizeBodyText({
			text: parsed.text,
			html: parsed.html,
		});

		const attachments = (parsed.attachments ?? []).map(
			(att: {
				filename?: string;
				contentType?: string;
				size?: number;
				contentId?: string;
				contentDisposition?: string;
			}) => ({
				id: randomUUID(),
				filename: att.filename ?? null,
				mimeType: att.contentType ?? null,
				sizeBytes: att.size ?? 0,
				contentId: att.contentId ?? null,
				isInline: att.contentDisposition === "inline" ? 1 : 0,
			}),
		);

		return {
			id: randomUUID(),
			messageId,
			threadKey: buildThreadKey({
				messageId,
				inReplyTo,
				subject: parsed.subject,
			}),
			receivedAt: coerceReceivedAt(parsed.date),
			senderName: parsed.from?.value?.[0]?.name ?? null,
			senderAddress: parsed.from?.value?.[0]?.address ?? null,
			toJson: toAddressJson(parsed.to?.value),
			ccJson: toAddressJson(parsed.cc?.value),
			subject: parsed.subject ?? null,
			inReplyTo,
			bodyTextNormalized: body.bodyTextNormalized,
			snippet: body.snippet,
			attachmentCount: attachments.length,
			hasHtml: body.hasHtml ? 1 : 0,
			parseStatus: "parsed",
			tokenEstimate: body.tokenEstimate,
			contentSha256: sha256,
			attachments,
		};
	} catch {
		return {
			id: randomUUID(),
			messageId: `<${randomUUID()}@parse-error>`,
			threadKey: `<${randomUUID()}@parse-error>`,
			receivedAt: null,
			senderName: null,
			senderAddress: null,
			toJson: "[]",
			ccJson: "[]",
			subject: null,
			inReplyTo: null,
			bodyTextNormalized: "",
			snippet: "",
			attachmentCount: 0,
			hasHtml: 0,
			parseStatus: "error",
			tokenEstimate: 0,
			contentSha256: sha256,
			attachments: [],
		};
	}
}

export async function getMailboxStatus(client: ImapFlow, mailbox: string) {
	const status = await client.status(mailbox, {
		uidValidity: true,
		uidNext: true,
		messages: true,
	});
	return {
		uidvalidity: status.uidValidity ?? 0,
		uidNext: status.uidNext ?? 0,
		messageCount: status.messages ?? 0,
	};
}
