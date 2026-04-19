import { describe, expect, it } from "vitest";

import {
	accountConnectionStateSchema,
	accountIdInputSchema,
	accountRecordSchema,
	accountSyncStateSchema,
	beginGoogleConnectInputSchema,
	googleOAuthRecordSchema,
	messageSourceRecordSchema,
} from "#/lib/schemas";

describe("new schemas", () => {
	const now = new Date().toISOString();

	it("accepts config_error as an account connection state", () => {
		expect(accountConnectionStateSchema.parse("config_error")).toBe(
			"config_error",
		);
	});

	describe("accountRecordSchema", () => {
		const validAccount = {
			id: "acct-1",
			label: "Work",
			emailAddress: "work@example.com",
			providerKind: "gmail",
			syncEnabled: true,
			syncStatus: "idle",
			sourceTruth: "corpus_mirror",
			selectedMailbox: "[Gmail]/All Mail",
			lastSyncedAt: null,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		} as const;

		it("accepts valid record", () => {
			expect(accountRecordSchema.parse(validAccount)).toMatchObject({
				id: "acct-1",
				providerKind: "gmail",
			});
		});

		it("rejects missing required fields", () => {
			const { id: _, ...noId } = validAccount;
			expect(() => accountRecordSchema.parse(noId)).toThrow();
		});

		it("rejects empty id", () => {
			expect(() =>
				accountRecordSchema.parse({ ...validAccount, id: "" }),
			).toThrow();
		});

		it("rejects invalid email", () => {
			expect(() =>
				accountRecordSchema.parse({
					...validAccount,
					emailAddress: "not-an-email",
				}),
			).toThrow();
		});

		it("rejects invalid provider kind", () => {
			expect(() =>
				accountRecordSchema.parse({
					...validAccount,
					providerKind: "outlook",
				}),
			).toThrow();
		});
	});

	describe("accountSyncStateSchema", () => {
		const validState = {
			accountId: "acct-1",
			uidvalidity: 12345,
			latestUidCursor: 100,
			earliestUidCursor: 1,
			backfillSnapshotUid: 100,
			backfillNextUid: null,
			lastBootstrapStartedAt: now,
			lastBootstrapCompletedAt: now,
			lastDeltaSyncAt: null,
			lastReconcileAt: null,
			lastBackfillSyncAt: now,
			backfillCompletedAt: now,
			lastIdleStartedAt: null,
			lastIdleHeartbeatAt: null,
			watcherStatus: "stopped",
			consecutiveFailures: 0,
			backoffUntil: null,
			createdAt: now,
			updatedAt: now,
		} as const;

		it("accepts valid state", () => {
			expect(accountSyncStateSchema.parse(validState)).toMatchObject({
				accountId: "acct-1",
				watcherStatus: "stopped",
			});
		});

		it("accepts null uidvalidity and nullable cursor fields", () => {
			expect(
				accountSyncStateSchema.parse({
					...validState,
					uidvalidity: null,
					latestUidCursor: null,
					earliestUidCursor: null,
					backfillSnapshotUid: null,
					backfillNextUid: null,
				}),
			).toMatchObject({
				uidvalidity: null,
				latestUidCursor: null,
				backfillNextUid: null,
			});
		});

		it("rejects negative consecutiveFailures", () => {
			expect(() =>
				accountSyncStateSchema.parse({
					...validState,
					consecutiveFailures: -1,
				}),
			).toThrow();
		});

		it("rejects invalid watcher status", () => {
			expect(() =>
				accountSyncStateSchema.parse({
					...validState,
					watcherStatus: "unknown",
				}),
			).toThrow();
		});

		it("accepts backfilling account records", () => {
			expect(
				accountRecordSchema.parse({
					id: "acct-2",
					label: "Backfill",
					emailAddress: "backfill@example.com",
					providerKind: "gmail",
					syncEnabled: true,
					syncStatus: "backfilling",
					sourceTruth: "corpus_mirror",
					selectedMailbox: "[Gmail]/All Mail",
					lastSyncedAt: null,
					lastError: null,
					createdAt: now,
					updatedAt: now,
				}),
			).toMatchObject({ syncStatus: "backfilling" });
		});
	});

	describe("messageSourceRecordSchema", () => {
		const validSource = {
			id: "src-1",
			messageId: "msg-1",
			accountId: "acct-1",
			remoteMessageId: "remote-1",
			remoteThreadId: "thread-1",
			mailbox: "[Gmail]/All Mail",
			imapUid: 42,
			uidvalidity: 12345,
			rawRfc822Path: "/path/to/file.eml",
			rawSha256: "abc123",
			state: "active",
			firstSeenAt: now,
			lastSeenAt: now,
			tombstonedAt: null,
			updatedAt: now,
		} as const;

		it("accepts valid source", () => {
			expect(messageSourceRecordSchema.parse(validSource)).toMatchObject({
				id: "src-1",
				state: "active",
			});
		});

		it("accepts tombstoned state", () => {
			expect(
				messageSourceRecordSchema.parse({
					...validSource,
					state: "tombstoned",
					tombstonedAt: now,
				}),
			).toMatchObject({ state: "tombstoned" });
		});

		it("accepts nullable fields as null", () => {
			expect(
				messageSourceRecordSchema.parse({
					...validSource,
					remoteMessageId: null,
					remoteThreadId: null,
					mailbox: null,
					imapUid: null,
					uidvalidity: null,
					rawRfc822Path: null,
					rawSha256: null,
				}),
			).toMatchObject({ remoteMessageId: null });
		});
	});

	describe("googleOAuthRecordSchema", () => {
		const validToken = {
			version: 1,
			provider: "google",
			emailAddress: "user@gmail.com",
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: now,
			scope: ["openid", "email"],
			tokenType: "Bearer",
			updatedAt: now,
		} as const;

		it("accepts valid token", () => {
			expect(googleOAuthRecordSchema.parse(validToken)).toMatchObject({
				version: 1,
				provider: "google",
			});
		});

		it("rejects wrong version", () => {
			expect(() =>
				googleOAuthRecordSchema.parse({ ...validToken, version: 2 }),
			).toThrow();
		});

		it("rejects wrong provider", () => {
			expect(() =>
				googleOAuthRecordSchema.parse({ ...validToken, provider: "github" }),
			).toThrow();
		});

		it("rejects empty accessToken", () => {
			expect(() =>
				googleOAuthRecordSchema.parse({ ...validToken, accessToken: "" }),
			).toThrow();
		});

		it("rejects invalid email", () => {
			expect(() =>
				googleOAuthRecordSchema.parse({
					...validToken,
					emailAddress: "not-email",
				}),
			).toThrow();
		});
	});

	describe("beginGoogleConnectInputSchema", () => {
		it("requires non-empty label", () => {
			expect(
				beginGoogleConnectInputSchema.parse({ label: "Work" }),
			).toMatchObject({ label: "Work" });
		});

		it("rejects empty label", () => {
			expect(() =>
				beginGoogleConnectInputSchema.parse({ label: "" }),
			).toThrow();
		});

		it("rejects missing label", () => {
			expect(() => beginGoogleConnectInputSchema.parse({})).toThrow();
		});
	});

	describe("accountIdInputSchema", () => {
		it("requires non-empty accountId", () => {
			expect(accountIdInputSchema.parse({ accountId: "acct-1" })).toMatchObject(
				{ accountId: "acct-1" },
			);
		});

		it("rejects empty accountId", () => {
			expect(() => accountIdInputSchema.parse({ accountId: "" })).toThrow();
		});

		it("rejects missing accountId", () => {
			expect(() => accountIdInputSchema.parse({})).toThrow();
		});
	});
});
