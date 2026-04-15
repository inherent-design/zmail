import { randomUUID } from "node:crypto";

type TestDb = Awaited<ReturnType<typeof import("#/lib/db")["getDb"]>>;

export async function seedTestAccount(
	db: TestDb,
	input?: {
		id?: string;
		label?: string;
		emailAddress?: string;
		syncEnabled?: number;
		syncStatus?:
			| "idle"
			| "syncing"
			| "backfilling"
			| "needs_reconnect"
			| "resync_required"
			| "paused"
			| "error";
	},
) {
	const { nowIso } = await import("#/lib/config");
	const id = input?.id ?? "acct-1";
	const emailAddress = input?.emailAddress ?? `${id}@example.com`;

	await db
		.insertInto("accounts")
		.values({
			id,
			label: input?.label ?? "Test Account",
			email_address: emailAddress,
			provider_kind: "gmail",
			sync_enabled: input?.syncEnabled ?? 1,
			sync_status: input?.syncStatus ?? "idle",
			source_truth: "corpus_mirror",
			selected_mailbox: "[Gmail]/All Mail",
			last_synced_at: null,
			last_error: null,
			created_at: nowIso(),
			updated_at: nowIso(),
		})
		.onConflict((oc) =>
			oc.column("id").doUpdateSet({
				label: input?.label ?? "Test Account",
				email_address: emailAddress,
				sync_enabled: input?.syncEnabled ?? 1,
				sync_status: input?.syncStatus ?? "idle",
				updated_at: nowIso(),
			}),
		)
		.execute();

	return id;
}

export async function insertConversationRow(
	db: TestDb,
	input?: {
		id?: string;
		accountId?: string;
		gmailThreadId?: string;
		firstMessageReceivedAt?: string | null;
		lastMessageReceivedAt?: string | null;
		messageCount?: number;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const id = input?.id ?? randomUUID();
	await db
		.insertInto("conversations")
		.values({
			id,
			account_id: input?.accountId ?? "acct-1",
			gmail_thread_id: input?.gmailThreadId ?? `gmail-thread-${id}`,
			first_message_received_at: input?.firstMessageReceivedAt ?? null,
			last_message_received_at: input?.lastMessageReceivedAt ?? null,
			message_count: input?.messageCount ?? 0,
			created_at: nowIso(),
			updated_at: nowIso(),
		})
		.execute();
	return id;
}

export async function bootDb(options?: { seedDefaultAccount?: boolean }) {
	const dbModule = await import("#/lib/db");
	dbModule.runMigrations();
	const db = dbModule.getDb();

	if (options?.seedDefaultAccount) {
		await seedTestAccount(db);
	}

	return {
		db,
		dbModule,
	};
}

export async function seedLegacyPreSecondarySchema() {
	const dbModule = await import("#/lib/db");
	const sqlite = dbModule.getSqlite();
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL
		);
		DELETE FROM _migrations;
		INSERT INTO _migrations (name, applied_at)
		VALUES ('001_init.sql', '2026-04-14T17:27:01.540Z');

		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			gmail_thread_id TEXT NOT NULL,
			first_message_received_at TEXT,
			last_message_received_at TEXT,
			message_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			thread_key TEXT NOT NULL,
			received_at TEXT,
			sender_name TEXT,
			sender_address TEXT,
			to_json TEXT NOT NULL,
			cc_json TEXT NOT NULL,
			subject TEXT,
			in_reply_to TEXT,
			body_text_normalized TEXT NOT NULL DEFAULT '',
			snippet TEXT NOT NULL DEFAULT '',
			attachment_count INTEGER NOT NULL DEFAULT 0,
			has_html INTEGER NOT NULL DEFAULT 0,
			raw_byte_start INTEGER NOT NULL DEFAULT 0,
			raw_byte_end INTEGER NOT NULL DEFAULT 0,
			parse_status TEXT NOT NULL DEFAULT 'parsed',
			token_estimate INTEGER NOT NULL DEFAULT 0,
			content_sha256 TEXT,
			created_at TEXT NOT NULL
		);
	`);
}

export async function seedSecondaryTablesMissingSchema() {
	const dbModule = await import("#/lib/db");
	const sqlite = dbModule.getSqlite();
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL
		);
		DELETE FROM _migrations;
		INSERT INTO _migrations (name, applied_at)
		VALUES ('001_init.sql', '2026-04-14T17:27:01.540Z');

		CREATE TABLE IF NOT EXISTS accounts (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			email_address TEXT NOT NULL,
			provider_kind TEXT NOT NULL DEFAULT 'gmail',
			sync_enabled INTEGER NOT NULL DEFAULT 0,
			sync_status TEXT NOT NULL DEFAULT 'idle',
			source_truth TEXT NOT NULL DEFAULT 'corpus_mirror',
			selected_mailbox TEXT NOT NULL DEFAULT '[Gmail]/All Mail',
			last_synced_at TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS account_sync_state (
			account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
			uidvalidity INTEGER,
			latest_uid_cursor INTEGER,
			earliest_uid_cursor INTEGER,
			backfill_snapshot_uid INTEGER,
			backfill_next_uid INTEGER,
			last_bootstrap_started_at TEXT,
			last_bootstrap_completed_at TEXT,
			last_delta_sync_at TEXT,
			last_reconcile_at TEXT,
			last_backfill_sync_at TEXT,
			backfill_completed_at TEXT,
			last_idle_started_at TEXT,
			last_idle_heartbeat_at TEXT,
			watcher_status TEXT NOT NULL DEFAULT 'stopped',
			consecutive_failures INTEGER NOT NULL DEFAULT 0,
			backoff_until TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			gmail_thread_id TEXT NOT NULL,
			first_message_received_at TEXT,
			last_message_received_at TEXT,
			message_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			thread_key TEXT NOT NULL,
			received_at TEXT,
			ingested_at TEXT NOT NULL,
			conversation_id TEXT,
			sender_name TEXT,
			sender_address TEXT,
			to_json TEXT NOT NULL,
			cc_json TEXT NOT NULL,
			subject TEXT,
			in_reply_to TEXT,
			body_text_primary TEXT NOT NULL DEFAULT '',
			body_text_forwarded TEXT NOT NULL DEFAULT '',
			body_text_normalized TEXT NOT NULL,
			snippet TEXT NOT NULL,
			attachment_count INTEGER NOT NULL DEFAULT 0,
			has_html INTEGER NOT NULL DEFAULT 0,
			raw_byte_start INTEGER NOT NULL DEFAULT 0,
			raw_byte_end INTEGER NOT NULL DEFAULT 0,
			parse_status TEXT NOT NULL,
			body_extraction_strategy TEXT NOT NULL DEFAULT 'plain_text',
			parse_error_reason TEXT,
			token_estimate INTEGER NOT NULL DEFAULT 0,
			content_sha256 TEXT,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS attachments (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			filename TEXT,
			mime_type TEXT,
			size_bytes INTEGER NOT NULL DEFAULT 0,
			content_id TEXT,
			is_inline INTEGER NOT NULL DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS message_sources (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			remote_message_id TEXT,
			remote_thread_id TEXT,
			mailbox TEXT,
			imap_uid INTEGER,
			uidvalidity INTEGER,
			raw_rfc822_path TEXT,
			raw_sha256 TEXT,
			state TEXT NOT NULL DEFAULT 'active',
			first_seen_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			tombstoned_at TEXT,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			scope_type TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			status TEXT NOT NULL,
			model TEXT,
			prompt_version TEXT,
			request_count INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0,
			claimed_at TEXT,
			lease_expires_at TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at TEXT NOT NULL,
			started_at TEXT,
			finished_at TEXT,
			meta_json TEXT NOT NULL DEFAULT '{}'
		);

		CREATE TABLE IF NOT EXISTS moderation_results (
			id TEXT PRIMARY KEY,
			job_id TEXT,
			message_id TEXT NOT NULL UNIQUE,
			model TEXT NOT NULL,
			categories_json TEXT NOT NULL,
			category_scores_json TEXT NOT NULL,
			raw_response_json TEXT NOT NULL,
			nsfw_flag INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS classification_results (
			id TEXT PRIMARY KEY,
			job_id TEXT,
			message_id TEXT NOT NULL,
			model TEXT NOT NULL,
			prompt_version TEXT NOT NULL,
			source TEXT NOT NULL,
			result_json TEXT NOT NULL,
			raw_response_json TEXT NOT NULL,
			usage_json TEXT,
			low_confidence INTEGER NOT NULL DEFAULT 0,
			input_content_sha256 TEXT,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS message_labels (
			message_id TEXT PRIMARY KEY,
			classification_result_id TEXT NOT NULL,
			source TEXT NOT NULL,
			label_json TEXT NOT NULL,
			primary_bucket TEXT NOT NULL,
			low_confidence INTEGER NOT NULL DEFAULT 0,
			nsfw INTEGER NOT NULL DEFAULT 0,
			content_sha256 TEXT,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS reviews (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			source_classification_result_id TEXT NOT NULL,
			status TEXT NOT NULL,
			reviewer_note TEXT,
			override_label_json TEXT,
			created_at TEXT NOT NULL,
			resolved_at TEXT
		);

		CREATE TABLE IF NOT EXISTS overseer_profiles (
			id TEXT PRIMARY KEY,
			account_id TEXT NOT NULL,
			built_from_messages INTEGER NOT NULL DEFAULT 0,
			promoted_tags_json TEXT NOT NULL,
			prompt_preamble TEXT NOT NULL,
			profile_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
}

export async function insertMessageRow(
	db: TestDb,
	input?: {
		id?: string;
		accountId?: string;
		messageId?: string;
		senderAddress?: string | null;
		subject?: string | null;
		bodyTextPrimary?: string;
		bodyTextForwarded?: string;
		bodyTextNormalized?: string;
		snippet?: string;
		receivedAt?: string | null;
		ingestedAt?: string;
		conversationId?: string | null;
		parseStatus?: string;
		bodyExtractionStrategy?: string;
		parseErrorReason?: string | null;
		contentSha256?: string | null;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const { buildContentSha256 } = await import("#/lib/normalize");
	const id = input?.id ?? randomUUID();
	const receivedAt =
		input && "receivedAt" in input
			? (input.receivedAt ?? null)
			: "2026-01-01T00:00:00.000Z";
	const senderAddress =
		input && "senderAddress" in input
			? (input.senderAddress ?? null)
			: "sender@example.com";
	const subject =
		input && "subject" in input ? (input.subject ?? null) : "Test message";
	const bodyTextForwarded = input?.bodyTextForwarded ?? "";
	const bodyTextPrimary =
		input?.bodyTextPrimary ?? input?.bodyTextNormalized ?? "hello world";
	const bodyTextNormalized =
		input?.bodyTextNormalized ??
		(bodyTextPrimary && bodyTextForwarded
			? `${bodyTextPrimary}\n\n[Forwarded content]\n${bodyTextForwarded}`
			: bodyTextPrimary || bodyTextForwarded || "");
	await db
		.insertInto("messages")
		.values({
			id,
			account_id: input?.accountId ?? "acct-1",
			message_id: input?.messageId ?? `<${id}@example.com>`,
			thread_key: input?.messageId ?? `<${id}@example.com>`,
			received_at: receivedAt,
			ingested_at: input?.ingestedAt ?? nowIso(),
			conversation_id:
				input && "conversationId" in input
					? (input.conversationId ?? null)
					: null,
			sender_name: "Sender",
			sender_address: senderAddress,
			to_json: "[]",
			cc_json: "[]",
			subject,
			in_reply_to: null,
			body_text_primary: bodyTextPrimary,
			body_text_forwarded: bodyTextForwarded,
			body_text_normalized: bodyTextNormalized,
			snippet: input?.snippet ?? (bodyTextPrimary || bodyTextForwarded || ""),
			attachment_count: 0,
			has_html: 0,
			raw_byte_start: 0,
			raw_byte_end: 10,
			parse_status: input?.parseStatus ?? "parsed",
			body_extraction_strategy: input?.bodyExtractionStrategy ?? "plain_text",
			parse_error_reason:
				input && "parseErrorReason" in input
					? (input.parseErrorReason ?? null)
					: null,
			token_estimate: Math.ceil(bodyTextNormalized.length / 4),
			content_sha256:
				input && "contentSha256" in input
					? (input.contentSha256 ?? null)
					: buildContentSha256({
							senderAddress,
							subject,
							receivedAt,
							bodyTextNormalized,
							attachments: [],
						}),
			created_at: nowIso(),
		})
		.execute();
	return id;
}

export async function insertMessageLabelRow(
	db: TestDb,
	input: {
		messageId: string;
		source?: string;
		primaryBucket?: string;
		lowConfidence?: number;
		nsfw?: number;
		contentSha256?: string | null;
		label?: Record<string, unknown>;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const label =
		input.label ??
		({
			schemaVersion: "message-label.v2",
			nsfw: false,
			finance: {
				relevant: false,
				direction: "unknown",
				owner: "unknown",
				accountHint: null,
				purpose: null,
			},
			people: {
				personal: false,
				private: false,
				networking: false,
				community: false,
				recruiting: false,
				business: false,
			},
			commerce: {
				transactional: false,
				shopping: false,
				subscription: false,
				travel: false,
				legal: false,
			},
			knowledge: {
				course: false,
				resource: false,
				documentation: false,
				newsletter: false,
				research: false,
			},
			assets: {
				license: false,
				credential: false,
				account: false,
				document: false,
			},
			entertainment: {
				gaming: false,
				media: false,
				fandom: false,
			},
			risk: {
				businessSensitive: false,
				leakRisk: false,
			},
			routing: {
				primaryBucket: input.primaryBucket ?? "other",
				secondaryBuckets: [],
				tags: [],
			},
			confidence: {
				overall: 1,
				finance: 1,
				people: 1,
				commerce: 1,
				knowledge: 1,
				assets: 1,
				entertainment: 1,
				risk: 1,
			},
			explanation: "ok",
		} satisfies Record<string, unknown>);

	await db
		.insertInto("classification_results")
		.values({
			id: `classification-${input.messageId}`,
			job_id: null,
			message_id: input.messageId,
			schema_version:
				(input.label?.schemaVersion as string | undefined) ??
				"message-label.v2",
			model: input.source === "manual" ? "manual" : "gpt-5.4-mini",
			prompt_version: "classify-email-v2",
			source: input.source ?? "model",
			result_json: JSON.stringify(label),
			raw_response_json: "{}",
			usage_json: null,
			low_confidence: input.lowConfidence ?? 0,
			input_content_sha256: input.contentSha256 ?? null,
			created_at: nowIso(),
		})
		.execute();

	await db
		.insertInto("message_labels")
		.values({
			message_id: input.messageId,
			classification_result_id: `classification-${input.messageId}`,
			schema_version:
				(input.label?.schemaVersion as string | undefined) ??
				"message-label.v2",
			source: input.source ?? "model",
			label_json: JSON.stringify(label),
			primary_bucket: input.primaryBucket ?? "other",
			low_confidence: input.lowConfidence ?? 0,
			nsfw: input.nsfw ?? 0,
			content_sha256: input.contentSha256 ?? null,
			updated_at: nowIso(),
		})
		.execute();
}

export async function insertSecondaryResultRow(
	db: TestDb,
	input: {
		messageId: string;
		classifierKey?: string;
		status?: string;
		contentSha256?: string | null;
		registrySha256?: string | null;
		result?: Record<string, unknown>;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const resultId = `secondary-${input.messageId}`;
	await db
		.insertInto("message_secondary_results")
		.values({
			id: resultId,
			message_id: input.messageId,
			classifier_key: input.classifierKey ?? "finance_intel",
			schema_version:
				(input.result?.schemaVersion as string | undefined) ??
				"finance-intel.v2",
			job_id: null,
			model: "gpt-5.4-mini",
			prompt_version: "finance-intel-v2",
			source: "model",
			result_json: JSON.stringify(
				input.result ?? {
					schemaVersion: "finance-intel.v2",
					messageKind: "receipt",
					actionability: "create_transaction_candidate",
					transactionCandidates: [],
					documentCandidates: [],
					matchedRegistryRefs: {
						identityIds: [],
						institutionIds: [],
						financialAccountIds: [],
					},
					unresolvedEntityHints: {
						identityHints: [],
						institutionHints: [],
						financialAccountHints: [],
					},
					confidence: {
						overall: 1,
						messageKind: 1,
						transactionExtraction: 1,
						registryMatching: 1,
					},
					explanation: "ok",
				},
			),
			raw_response_json: "{}",
			usage_json: null,
			input_content_sha256: input.contentSha256 ?? null,
			input_registry_sha256: input.registrySha256 ?? null,
			created_at: nowIso(),
		})
		.execute();

	await db
		.insertInto("message_secondary_heads")
		.values({
			message_id: input.messageId,
			classifier_key: input.classifierKey ?? "finance_intel",
			secondary_result_id: resultId,
			status: input.status ?? "ready",
			low_confidence: 0,
			content_sha256: input.contentSha256 ?? null,
			registry_sha256: input.registrySha256 ?? null,
			updated_at: nowIso(),
		})
		.execute();

	return resultId;
}

export async function insertAccountSyncStateRow(
	db: TestDb,
	input: {
		accountId: string;
		uidvalidity?: number | null;
		latestUidCursor?: number | null;
		earliestUidCursor?: number | null;
		backfillSnapshotUid?: number | null;
		backfillNextUid?: number | null;
		watcherStatus?: "running" | "stopped";
		consecutiveFailures?: number;
	},
) {
	const { nowIso } = await import("#/lib/config");
	await db
		.insertInto("account_sync_state")
		.values({
			account_id: input.accountId,
			uidvalidity: input.uidvalidity ?? 1,
			latest_uid_cursor: input.latestUidCursor ?? 1,
			earliest_uid_cursor: input.earliestUidCursor ?? 1,
			backfill_snapshot_uid: input.backfillSnapshotUid ?? null,
			backfill_next_uid: input.backfillNextUid ?? null,
			last_bootstrap_started_at: null,
			last_bootstrap_completed_at: null,
			last_delta_sync_at: null,
			last_reconcile_at: null,
			last_backfill_sync_at: null,
			backfill_completed_at: null,
			last_idle_started_at: null,
			last_idle_heartbeat_at: null,
			watcher_status: input.watcherStatus ?? "stopped",
			consecutive_failures: input.consecutiveFailures ?? 0,
			backoff_until: null,
			created_at: nowIso(),
			updated_at: nowIso(),
		})
		.onConflict((oc) =>
			oc.column("account_id").doUpdateSet({
				uidvalidity: input.uidvalidity ?? 1,
				latest_uid_cursor: input.latestUidCursor ?? 1,
				earliest_uid_cursor: input.earliestUidCursor ?? 1,
				backfill_snapshot_uid: input.backfillSnapshotUid ?? null,
				backfill_next_uid: input.backfillNextUid ?? null,
				watcher_status: input.watcherStatus ?? "stopped",
				consecutive_failures: input.consecutiveFailures ?? 0,
				updated_at: nowIso(),
			}),
		)
		.execute();
}

export async function insertAttachmentRow(
	db: TestDb,
	input: {
		id?: string;
		messageId: string;
		filename?: string | null;
		mimeType?: string | null;
		sizeBytes?: number;
		contentId?: string | null;
		isInline?: number;
	},
) {
	const id = input.id ?? randomUUID();
	await db
		.insertInto("attachments")
		.values({
			id,
			message_id: input.messageId,
			filename: input.filename ?? null,
			mime_type: input.mimeType ?? null,
			size_bytes: input.sizeBytes ?? 0,
			content_id:
				input && "contentId" in input ? (input.contentId ?? null) : null,
			is_inline: input.isInline ?? 0,
		})
		.execute();
	return id;
}

export async function insertMessageSourceRow(
	db: TestDb,
	input: {
		id?: string;
		messageId: string;
		accountId: string;
		remoteMessageId: string;
		remoteThreadId: string;
		mailbox?: string | null;
		imapUid?: number | null;
		uidvalidity?: number | null;
		rawRfc822Path?: string | null;
		rawSha256?: string | null;
		state?: "active" | "tombstoned";
		firstSeenAt?: string;
		lastSeenAt?: string;
		tombstonedAt?: string | null;
		updatedAt?: string;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const id = input.id ?? `source-${input.messageId}`;
	const firstSeenAt = input.firstSeenAt ?? nowIso();
	const lastSeenAt = input.lastSeenAt ?? firstSeenAt;
	await db
		.insertInto("message_sources")
		.values({
			id,
			message_id: input.messageId,
			account_id: input.accountId,
			remote_message_id: input.remoteMessageId,
			remote_thread_id: input.remoteThreadId,
			mailbox: input.mailbox ?? "[Gmail]/All Mail",
			imap_uid:
				input && "imapUid" in input ? (input.imapUid ?? null) : null,
			uidvalidity:
				input && "uidvalidity" in input ? (input.uidvalidity ?? null) : null,
			raw_rfc822_path:
				input && "rawRfc822Path" in input
					? (input.rawRfc822Path ?? null)
					: null,
			raw_sha256:
				input && "rawSha256" in input ? (input.rawSha256 ?? null) : null,
			state: input.state ?? "active",
			first_seen_at: firstSeenAt,
			last_seen_at: lastSeenAt,
			tombstoned_at:
				input.tombstonedAt ??
				(input.state === "tombstoned" ? lastSeenAt : null),
			updated_at: input.updatedAt ?? lastSeenAt,
		})
		.execute();
	return id;
}

export async function insertReviewRow(
	db: TestDb,
	input: {
		id?: string;
		messageId: string;
		sourceClassificationResultId: string;
		status?: "open" | "resolved";
		reviewerNote?: string | null;
		overrideLabelJson?: string | null;
		createdAt?: string;
		resolvedAt?: string | null;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const id = input.id ?? randomUUID();
	await db
		.insertInto("reviews")
		.values({
			id,
			message_id: input.messageId,
			source_classification_result_id: input.sourceClassificationResultId,
			status: input.status ?? "open",
			reviewer_note:
				input && "reviewerNote" in input ? (input.reviewerNote ?? null) : null,
			override_label_json:
				input && "overrideLabelJson" in input
					? (input.overrideLabelJson ?? null)
					: null,
			created_at: input.createdAt ?? nowIso(),
			resolved_at:
				input && "resolvedAt" in input ? (input.resolvedAt ?? null) : null,
		})
		.execute();
	return id;
}

export async function insertOverseerProfileRow(
	db: TestDb,
	input: {
		id?: string;
		accountId: string;
		builtFromMessages?: number;
		promotedTagsJson?: string;
		promptPreamble?: string;
		profileJson: string;
		createdAt?: string;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const id = input.id ?? randomUUID();
	await db
		.insertInto("overseer_profiles")
		.values({
			id,
			account_id: input.accountId,
			built_from_messages: input.builtFromMessages ?? 0,
			promoted_tags_json: input.promotedTagsJson ?? "[]",
			prompt_preamble: input.promptPreamble ?? "",
			profile_json: input.profileJson,
			created_at: input.createdAt ?? nowIso(),
		})
		.execute();
	return id;
}
