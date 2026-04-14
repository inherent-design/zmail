import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#/test/helpers/runtime";

describe("imap", () => {
	it("createImapClient returns ImapFlow instance with correct config", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mockConstructor = vi.fn().mockImplementation((config: unknown) => ({
			_config: config,
		}));

		vi.doMock("imapflow", () => ({
			ImapFlow: mockConstructor,
		}));

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const client = mod.createImapClient({
			email: "user@gmail.com",
			accessToken: "tok-123",
		});

		expect(mockConstructor).toHaveBeenCalledOnce();
		const config = mockConstructor.mock.calls[0][0];
		expect(config).toMatchObject({
			host: "imap.gmail.com",
			port: 993,
			secure: true,
			auth: {
				user: "user@gmail.com",
				accessToken: "tok-123",
			},
			logger: false,
		});
		expect(client).toBeTruthy();
	});

	it("writeRawEml writes file to correct path", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const raw = Buffer.from("raw email content");
		const path = mod.writeRawEml("acct-1", "msg-abc", raw);

		expect(path).toContain("acct-1");
		expect(path).toContain("msg-abc.eml");
		expect(existsSync(path)).toBe(true);
	});

	it("writeRawEml rejects traversal-like remote ids without touching files outside account raw storage", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const config =
			await runtime.importFresh<typeof import("#/lib/config")>("#/lib/config");
		const raw = Buffer.from("raw email content");
		const victimPath = resolve(config.ACCOUNTS_DIR, "victim.eml");

		expect(() => mod.writeRawEml("acct-1", "../../victim", raw)).toThrow(
			"Invalid remoteMessageId",
		);
		expect(existsSync(victimPath)).toBe(false);
	});

	it("writeRawEml rejects empty remote ids", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const raw = Buffer.from("raw email content");

		expect(() => mod.writeRawEml("acct-1", "", raw)).toThrow(
			"Invalid remoteMessageId",
		);
	});

	it("parseRawMessage parses a simple RFC822 message", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");

		// Use multipart/alternative so mailparser returns string html (not false)
		const rawEmail = Buffer.from(
			[
				"From: sender@example.com",
				"To: recipient@example.com",
				"Subject: Test",
				"Date: Sat, 01 Jan 2026 00:00:00 +0000",
				"Message-ID: <test@example.com>",
				"MIME-Version: 1.0",
				'Content-Type: multipart/alternative; boundary="testbound"',
				"",
				"--testbound",
				"Content-Type: text/plain",
				"",
				"Hello world",
				"--testbound",
				"Content-Type: text/html",
				"",
				"<p>Hello world</p>",
				"--testbound--",
			].join("\r\n"),
		);

		const sha256 = "abc123def456";
		const parsed = await mod.parseRawMessage(rawEmail, sha256);

		expect(parsed.parseStatus).toBe("parsed");
		expect(parsed.messageId).toBe("<test@example.com>");
		expect(parsed.subject).toBe("Test");
		expect(parsed.senderAddress).toBe("sender@example.com");
		expect(parsed.bodyTextNormalized).toContain("Hello world");
		expect(parsed.snippet).toContain("Hello world");
		expect(parsed.contentSha256).toBe(sha256);
		expect(parsed.attachmentCount).toBe(0);
		expect(parsed.attachments).toEqual([]);
		expect(parsed.hasHtml).toBe(1);
		expect(parsed.id).toBeTruthy();
		expect(parsed.threadKey).toBeTruthy();
		expect(parsed.receivedAt).toBeTruthy();

		const to = JSON.parse(parsed.toJson);
		expect(to).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ address: "recipient@example.com" }),
			]),
		);
	});

	it("parseRawMessage handles parse errors gracefully", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		vi.doMock("mailparser", () => ({
			simpleParser: vi.fn().mockRejectedValue(new Error("parse failure")),
		}));

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");

		const parsed = await mod.parseRawMessage(Buffer.from("garbage"), "sha-bad");

		expect(parsed.parseStatus).toBe("error");
		expect(parsed.contentSha256).toBe("sha-bad");
		expect(parsed.bodyTextNormalized).toBe("");
		expect(parsed.snippet).toBe("");
		expect(parsed.attachmentCount).toBe(0);
		expect(parsed.senderAddress).toBeNull();
		expect(parsed.subject).toBeNull();
		expect(parsed.toJson).toBe("[]");
		expect(parsed.ccJson).toBe("[]");
	});

	it("fetchMessageWindow uses a bounded range and skips empty source rows", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");

		const fetch = vi.fn(async function* () {
			yield {
				uid: 1,
				source: undefined,
				internalDate: new Date("2026-01-01T00:00:00.000Z"),
			};
			yield {
				uid: 2,
				source: Buffer.from("first"),
				internalDate: new Date("2026-01-02T00:00:00.000Z"),
				emailId: "gmail-id-2",
				threadId: "thread-2",
			};
		});
		const client = { fetch };

		const messages = await mod.fetchMessageWindow(client as never, 1, 2);

		expect(fetch).toHaveBeenCalledWith(
			"1:2",
			expect.objectContaining({
				uid: true,
				source: true,
				internalDate: true,
			}),
			{ uid: true },
		);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			uid: 2,
			gmMsgId: "gmail-id-2",
			gmThrid: "thread-2",
			raw: Buffer.from("first"),
		});
	});

	it("fetchMessageWindow maps Gmail ids within the requested bounded range", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");

		const client = {
			async *fetch() {
				yield {
					uid: 2,
					source: Buffer.from("first"),
					internalDate: new Date("2026-01-02T00:00:00.000Z"),
					emailId: "gmail-id-2",
					threadId: "thread-2",
				};
				yield {
					uid: 3,
					source: Buffer.from("second"),
					internalDate: undefined,
					emailId: "gmail-id-3",
					threadId: "thread-3",
				};
			},
		};

		const messages = await mod.fetchMessageWindow(client as never, 2, 2);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			uid: 2,
			gmMsgId: "gmail-id-2",
			gmThrid: "thread-2",
			raw: Buffer.from("first"),
		});
		expect(messages[1].uid).toBe(3);
		expect(messages[1].gmMsgId).toBe("gmail-id-3");
		expect(messages[1].gmThrid).toBe("thread-3");
		expect(messages[1].internalDate).toBeInstanceOf(Date);
	});

	it("fetchMessageWindow returns no messages when the window size is less than one", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const fetch = vi.fn();
		const client = { fetch };

		await expect(
			mod.fetchMessageWindow(client as never, 5, 0),
		).resolves.toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("fetchMessageWindow falls back to x-gm fields when typed ids are missing", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");

		const client = {
			async *fetch() {
				yield {
					uid: 9,
					source: Buffer.from("fallback"),
					internalDate: new Date("2026-01-09T00:00:00.000Z"),
					"x-gm-msgid": "gm-fallback",
					"x-gm-thrid": "thr-fallback",
				};
			},
		};

		const messages = await mod.fetchMessageWindow(client as never, 9, 5);

		expect(messages).toEqual([
			expect.objectContaining({
				uid: 9,
				gmMsgId: "gm-fallback",
				gmThrid: "thr-fallback",
			}),
		]);
	});

	it("fetchMessageWindow falls back to empty Gmail ids when none are present", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const client = {
			async *fetch() {
				yield {
					uid: 10,
					source: Buffer.from("no-ids"),
					internalDate: new Date("2026-01-10T00:00:00.000Z"),
				};
			},
		};

		expect(await mod.fetchMessageWindow(client as never, 10, 5)).toEqual([
			expect.objectContaining({
				uid: 10,
				gmMsgId: "",
				gmThrid: "",
			}),
		]);
	});

	it("fetchMessageWindowDescending uses a bounded range and sorts descending in userland", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const fetch = vi.fn(async function* () {
			yield {
				uid: 4,
				source: Buffer.from("four"),
				internalDate: "2026-01-04T00:00:00.000Z",
			};
			yield {
				uid: 5,
				source: Buffer.from("five"),
				internalDate: new Date("2026-01-05T00:00:00.000Z"),
			};
			yield {
				uid: 3,
				source: Buffer.from("three"),
				internalDate: new Date("2026-01-03T00:00:00.000Z"),
			};
		});
		const client = { fetch };

		const messages = await mod.fetchMessageWindowDescending(
			client as never,
			5,
			3,
		);

		expect(fetch).toHaveBeenCalledWith(
			"3:5",
			expect.objectContaining({
				uid: true,
				source: true,
				internalDate: true,
			}),
			{ uid: true },
		);
		expect(messages.map((message) => message.uid)).toEqual([5, 4, 3]);
		expect(messages[0].internalDate).toBeInstanceOf(Date);
	});

	it("fetchMessageRange returns no messages when the requested range is inverted", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const fetch = vi.fn();
		const client = { fetch };

		await expect(mod.fetchMessageRange(client as never, 8, 7)).resolves.toEqual(
			[],
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("getMailboxStatus normalizes bigint status values", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const client = {
			status: vi.fn(async () => ({
				uidValidity: 123n,
				uidNext: 456n,
				messages: 7,
			})),
		};

		const status = await mod.getMailboxStatus(
			client as never,
			"[Gmail]/All Mail",
		);

		expect(client.status).toHaveBeenCalledWith("[Gmail]/All Mail", {
			uidValidity: true,
			uidNext: true,
			messages: true,
		});
		expect(status).toEqual({
			uidvalidity: 123n,
			uidNext: 456n,
			messageCount: 7,
		});
	});

	it("parseRawMessage fills fallback fields for sparse parsed mail", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		vi.doMock("mailparser", () => ({
			simpleParser: vi.fn(async () => ({
				messageId: undefined,
				inReplyTo: undefined,
				text: undefined,
				html: undefined,
				attachments: undefined,
				from: undefined,
				to: undefined,
				cc: undefined,
				subject: undefined,
				date: undefined,
			})),
		}));

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const parsed = await mod.parseRawMessage(Buffer.from("raw"), "sha-sparse");

		expect(parsed.parseStatus).toBe("parsed");
		expect(parsed.messageId).toContain("@unknown>");
		expect(parsed.inReplyTo).toBeNull();
		expect(parsed.senderName).toBeNull();
		expect(parsed.senderAddress).toBeNull();
		expect(parsed.toJson).toBe("[]");
		expect(parsed.ccJson).toBe("[]");
		expect(parsed.subject).toBeNull();
		expect(parsed.hasHtml).toBe(0);
		expect(parsed.contentSha256).toBe("sha-sparse");
		expect(parsed.attachments).toEqual([]);
	});

	it("parseRawMessage preserves reply metadata and non-inline attachments", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		vi.doMock("mailparser", () => ({
			simpleParser: vi.fn(async () => ({
				messageId: "<reply@example.com>",
				inReplyTo: "<parent@example.com>",
				text: "Reply body",
				html: "<p>Reply body</p>",
				attachments: [
					{
						filename: "receipt.txt",
						contentType: "text/plain",
						size: 12,
						contentId: "cid-1",
						contentDisposition: "attachment",
					},
					{
						filename: "inline.txt",
						contentType: "text/plain",
						size: 8,
						contentId: "cid-inline",
						contentDisposition: "inline",
					},
					{
						filename: undefined,
						contentType: undefined,
						size: undefined,
						contentId: undefined,
						contentDisposition: "attachment",
					},
				],
				from: {
					value: [{ name: "Sender", address: "sender@example.com" }],
				},
				to: {
					value: [{ address: "to@example.com" }],
				},
				cc: {
					value: [{ address: "cc@example.com" }],
				},
				subject: "Reply subject",
				date: new Date("2026-01-11T00:00:00.000Z"),
			})),
		}));

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const parsed = await mod.parseRawMessage(
			Buffer.from("reply raw"),
			"sha-reply",
		);

		expect(parsed.messageId).toBe("<reply@example.com>");
		expect(parsed.inReplyTo).toBe("<parent@example.com>");
		expect(parsed.ccJson).toContain("cc@example.com");
		expect(parsed.attachments).toEqual([
			expect.objectContaining({
				filename: "receipt.txt",
				mimeType: "text/plain",
				sizeBytes: 12,
				contentId: "cid-1",
				isInline: 0,
			}),
			expect.objectContaining({
				filename: "inline.txt",
				mimeType: "text/plain",
				sizeBytes: 8,
				contentId: "cid-inline",
				isInline: 1,
			}),
			expect.objectContaining({
				filename: null,
				mimeType: null,
				sizeBytes: 0,
				contentId: null,
				isInline: 0,
			}),
		]);
	});

	it("getMailboxStatus falls back to zero when status fields are missing", async () => {
		const runtime = await createTestRuntime();
		vi.resetModules();

		const mod =
			await runtime.importFresh<typeof import("#/lib/imap")>("#/lib/imap");
		const client = {
			status: vi.fn(async () => ({
				uidValidity: undefined,
				uidNext: undefined,
				messages: undefined,
			})),
		};

		expect(
			await mod.getMailboxStatus(client as never, "[Gmail]/All Mail"),
		).toEqual({
			uidvalidity: 0,
			uidNext: 0,
			messageCount: 0,
		});
	});
});
