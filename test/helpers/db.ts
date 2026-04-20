import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type TestDb = Awaited<ReturnType<typeof import("#/lib/db")["getDb"]>>;

export async function seedTestAccount(
	db: TestDb,
	input?: {
		id?: string;
		label?: string;
		emailAddress?: string;
		ownerPrincipalEmail?: string | null;
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
			owner_principal_email: input?.ownerPrincipalEmail ?? null,
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
				...(input?.ownerPrincipalEmail !== undefined
					? {
							owner_principal_email: input.ownerPrincipalEmail,
						}
					: {}),
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

export async function seedStaleCanonicalMigrationHistory(input?: {
	orgId?: string;
	withSampleData?: boolean;
	missingOwnerPrincipalEmail?: boolean;
	missingConnectionState?: boolean;
	missingJobLaneColumns?: boolean;
	migrationNames?: string[];
}) {
	const dbModule = await import("#/lib/db");
	const sqlite = dbModule.getSqlite(input?.orgId);
	const canonicalSql = readFileSync(
		resolve(process.cwd(), "db", "migrations", "001_init.sql"),
		"utf8",
	);
	let staleSql = canonicalSql;
	if (input?.missingOwnerPrincipalEmail !== false) {
		staleSql = staleSql.replace("  owner_principal_email TEXT,\n", "");
	}
	if (input?.missingConnectionState) {
		staleSql = staleSql.replace(
			/ {2}updated_at TEXT NOT NULL,\n {2}connection_state TEXT NOT NULL DEFAULT 'connected'\n {2}CHECK \(connection_state IN \('connected', 'config_error', 'paused', 'needs_reconnect', 'disconnected'\)\)\);/,
			"  updated_at TEXT NOT NULL\n);",
		);
	}
	if (input?.missingJobLaneColumns) {
		const before = staleSql;
		staleSql = staleSql
			.replace("  lane TEXT NOT NULL DEFAULT 'materialize',\n", "")
			.replace("  priority INTEGER NOT NULL DEFAULT 100,\n", "")
			.replace("  run_after_at TEXT,\n", "")
			.replace("  claim_owner TEXT,\n", "")
			.replace(
				/CREATE INDEX IF NOT EXISTS jobs_lane_status_priority_idx\n {2}ON jobs \(lane, status, priority, created_at\);\n/,
				"",
			)
			.replace(
				/CREATE INDEX IF NOT EXISTS jobs_run_after_idx\n {2}ON jobs \(status, run_after_at\);\n/,
				"",
			);
		if (staleSql === before) {
			throw new Error("Expected canonical 001_init.sql to contain job lanes");
		}
	}
	if (
		staleSql === canonicalSql &&
		(input?.missingOwnerPrincipalEmail !== false ||
			input?.missingConnectionState ||
			input?.missingJobLaneColumns)
	) {
		throw new Error("Expected canonical 001_init.sql to contain owner column");
	}
	const migrationNames = input?.migrationNames ?? [
		"001_init.sql",
		"002_secondary_schema.sql",
		"003_finance_imports_and_taxonomy.sql",
		"004_runtime_events.sql",
	];
	const migrationRows = migrationNames
		.map((name, index) => `('${name}', '2026-04-15T0${index}:00:00.000Z')`)
		.join(",\n\t\t\t");

	sqlite.exec(staleSql);
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL
		);
		DELETE FROM _migrations;
		INSERT INTO _migrations (name, applied_at)
		VALUES
			${migrationRows};
	`);

	if (!input?.withSampleData) {
		return;
	}

	sqlite.exec(`
		INSERT INTO accounts (
			id,
			label,
			email_address,
			provider_kind,
			sync_enabled,
			sync_status,
			source_truth,
			selected_mailbox,
			last_synced_at,
			last_error,
			created_at,
			updated_at
		)
		VALUES (
			'acct-stale',
			'Stale Account',
			'stale@example.com',
			'gmail',
			1,
			'idle',
			'corpus_mirror',
			'[Gmail]/All Mail',
			NULL,
			NULL,
			'2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z'
		);

		INSERT INTO messages (
			id,
			account_id,
			message_id,
			thread_key,
			received_at,
			ingested_at,
			conversation_id,
			sender_name,
			sender_address,
			to_json,
			cc_json,
			subject,
			in_reply_to,
			body_text_primary,
			body_text_forwarded,
			body_text_normalized,
			snippet,
			attachment_count,
			has_html,
			raw_byte_start,
			raw_byte_end,
			parse_status,
			body_extraction_strategy,
			parse_error_reason,
			token_estimate,
			content_sha256,
			created_at
		)
		VALUES (
			'msg-stale',
			'acct-stale',
			'remote-stale',
			'thread-stale',
			'2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z',
			NULL,
			'Sender',
			'sender@example.com',
			'[]',
			'[]',
			'Subject',
			NULL,
			'Primary body',
			'',
			'Primary body',
			'Snippet',
			0,
			0,
			0,
			0,
			'parsed',
			'plain_text',
			NULL,
			10,
			'sha-msg-stale',
			'2026-01-01T00:00:00.000Z'
		);

		INSERT INTO classification_results (
			id,
			job_id,
			message_id,
			schema_version,
			model,
			prompt_version,
			source,
			result_json,
			raw_response_json,
			usage_json,
			low_confidence,
			input_content_sha256,
			created_at
		)
		VALUES (
			'class-stale',
			NULL,
			'msg-stale',
			'message-label.v2',
			'gpt-test',
			'classify-email-v2',
			'model',
			'{}',
			'{}',
			NULL,
			0,
			'sha-msg-stale',
			'2026-01-01T00:00:00.000Z'
		);

		INSERT INTO message_labels (
			message_id,
			classification_result_id,
			schema_version,
			source,
			label_json,
			primary_bucket,
			low_confidence,
			nsfw,
			content_sha256,
			updated_at
		)
		VALUES (
			'msg-stale',
			'class-stale',
			'message-label.v2',
			'model',
			'{}',
			'finance',
			0,
			0,
			'sha-msg-stale',
			'2026-01-01T00:00:00.000Z'
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
		promptVersion?: string;
		promptSha256?: string | null;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const { CLASSIFY_PROMPT_VERSION } = await import("#/lib/config");
	const { promptSha256ForName } = await import("#/lib/prompt-identity");
	const label =
		input.label ??
		({
			schemaVersion: "message-label.v3",
			nsfw: false,
			finance: {
				relevant: false,
				signal: "none",
				operational: false,
				bookHint: "unknown",
				requiresFinanceIntel: false,
				confidence: 1,
				evidence: null,
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
	const derivedPrimaryBucket =
		input.primaryBucket ??
		(typeof label.routing === "object" &&
		label.routing !== null &&
		"primaryBucket" in label.routing
			? String(
					(label.routing as { primaryBucket?: string }).primaryBucket ??
						"other",
				)
			: "other");

	await db
		.insertInto("classification_results")
		.values({
			id: `classification-${input.messageId}`,
			job_id: null,
			message_id: input.messageId,
			schema_version:
				(input.label?.schemaVersion as string | undefined) ??
				"message-label.v3",
			model: input.source === "manual" ? "manual" : "gpt-5.4-mini",
			prompt_version: input.promptVersion ?? CLASSIFY_PROMPT_VERSION,
			prompt_sha256:
				input.promptSha256 ??
				(input.source === "manual"
					? null
					: promptSha256ForName("classify-email-v3.md")),
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
				"message-label.v3",
			source: input.source ?? "model",
			label_json: JSON.stringify(label),
			primary_bucket: derivedPrimaryBucket,
			low_confidence: input.lowConfidence ?? 0,
			nsfw: input.nsfw ?? 0,
			content_sha256: input.contentSha256 ?? null,
			updated_at: nowIso(),
		})
		.execute();
}

export async function insertModerationResultRow(
	db: TestDb,
	input: {
		messageId: string;
		jobId?: string | null;
		model?: string;
		nsfw?: boolean;
	},
) {
	const [{ nowIso, MODERATION_PROMPT_VERSION }, { jsonText }] =
		await Promise.all([import("#/lib/config"), import("#/lib/db")]);
	const moderation = {
		nsfw: input.nsfw ?? false,
		categories: {
			explicitSexual: false,
			suggestiveSexual: false,
			nudity: false,
			sexualMinors: false,
			adultCommercial: false,
		},
		scores: {
			explicitSexual: 0.01,
			suggestiveSexual: 0.02,
			nudity: 0.01,
			sexualMinors: 0,
			adultCommercial: 0.03,
			overall: 0.03,
		},
		explanation: "safe",
	};
	await db
		.insertInto("moderation_results")
		.values({
			id: `moderation-${input.messageId}`,
			job_id: input.jobId ?? null,
			message_id: input.messageId,
			model: input.model ?? "gpt-5.4-mini",
			categories_json: jsonText(moderation.categories),
			category_scores_json: jsonText(moderation.scores),
			raw_response_json: jsonText({
				promptVersion: MODERATION_PROMPT_VERSION,
				backend: "test",
			}),
			nsfw_flag: moderation.nsfw ? 1 : 0,
			created_at: nowIso(),
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
		promptVersion?: string;
		promptSha256?: string | null;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const { FINANCE_INTEL_PROMPT_VERSION } = await import("#/lib/config");
	const { promptSha256ForName } = await import("#/lib/prompt-identity");
	const resultId = `secondary-${input.messageId}`;
	await db
		.insertInto("message_secondary_results")
		.values({
			id: resultId,
			message_id: input.messageId,
			classifier_key: input.classifierKey ?? "finance_intel",
			schema_version:
				(input.result?.schemaVersion as string | undefined) ??
				"finance-intel.v3",
			job_id: null,
			model: "gpt-5.4-mini",
			prompt_version: input.promptVersion ?? FINANCE_INTEL_PROMPT_VERSION,
			prompt_sha256:
				input.promptSha256 ?? promptSha256ForName("finance-intel-v3.md"),
			source: "model",
			result_json: JSON.stringify(
				input.result ?? {
					schemaVersion: "finance-intel.v3",
					messageKind: "receipt",
					actionability: "create_transaction_candidate",
					book: {
						scope: "unknown",
						businessUsePercent: null,
						taxTreatmentHint: null,
						evidence: null,
					},
					ledgerReadiness: {
						status: "review",
						reasons: ["no fixture transaction"],
						requiredFixes: ["transaction"],
					},
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
					dedupe: {
						messageEvidenceKey: null,
						sourceDocumentRefs: [],
						externalTransactionIds: [],
						normalizedComposites: [],
					},
					fieldConfidence: {
						amount: null,
						date: null,
						counterparty: null,
						accountMapping: null,
						book: null,
						category: null,
						dedupe: null,
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
			imap_uid: input && "imapUid" in input ? (input.imapUid ?? null) : null,
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
