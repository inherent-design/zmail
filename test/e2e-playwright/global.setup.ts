import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import Database from "better-sqlite3";

import {
	BACKLOG_BODY,
	BACKLOG_MESSAGE_ID,
	BACKLOG_REMOTE_ID,
	BACKLOG_SUBJECT,
	buildLowConfidenceLabel,
	buildSeededProfile,
	CLASSIFY_NOW_BODY,
	CLASSIFY_NOW_MESSAGE_ID,
	CLASSIFY_NOW_REMOTE_ID,
	CLASSIFY_NOW_SUBJECT,
	LIVE_ACCOUNT_EMAIL,
	LIVE_ACCOUNT_ID,
	LIVE_ACCOUNT_LABEL,
	REVIEW_BODY,
	REVIEW_MESSAGE_ID,
	REVIEW_REMOTE_ID,
	REVIEW_RESULT_ID,
	REVIEW_ROW_ID,
	REVIEW_SUBJECT,
	SEEDED_PROFILE_ID,
} from "./live-fixtures";

function sha256(input: string) {
	return createHash("sha256").update(input).digest("hex");
}

async function seedRuntime(dataDir: string) {
	const dbPath = resolve(dataDir, "zmail.sqlite");
	const db = new Database(dbPath);
	db.pragma("foreign_keys = ON");

	const now = new Date().toISOString();
	const rawDir = resolve(dataDir, "accounts", LIVE_ACCOUNT_ID, "raw");
	await mkdir(rawDir, { recursive: true });

	const backlogRawPath = resolve(rawDir, `${BACKLOG_REMOTE_ID}.eml`);
	const classifyNowRawPath = resolve(rawDir, `${CLASSIFY_NOW_REMOTE_ID}.eml`);
	const reviewRawPath = resolve(rawDir, `${REVIEW_REMOTE_ID}.eml`);

	await writeFile(
		backlogRawPath,
		`Subject: ${BACKLOG_SUBJECT}\nFrom: billing@vendor.example\n\n${BACKLOG_BODY}\n`,
	);
	await writeFile(
		classifyNowRawPath,
		`Subject: ${CLASSIFY_NOW_SUBJECT}\nFrom: friend@example.com\n\n${CLASSIFY_NOW_BODY}\n`,
	);
	await writeFile(
		reviewRawPath,
		`Subject: ${REVIEW_SUBJECT}\nFrom: accounting@example.com\n\n${REVIEW_BODY}\n`,
	);

	const backlogHash = sha256(BACKLOG_BODY);
	const classifyNowHash = sha256(CLASSIFY_NOW_BODY);
	const reviewHash = sha256(REVIEW_BODY);
	const lowConfidenceLabel = buildLowConfidenceLabel();
	const seededProfile = buildSeededProfile();

	db.prepare(
		`
			INSERT INTO accounts (
				id, label, email_address, provider_kind, sync_enabled, sync_status,
				source_truth, selected_mailbox, last_synced_at, last_error, created_at,
				updated_at
			) VALUES (?, ?, ?, 'gmail', 0, 'paused', 'corpus_mirror',
				'[Gmail]/All Mail', ?, NULL, ?, ?)
		`,
	).run(LIVE_ACCOUNT_ID, LIVE_ACCOUNT_LABEL, LIVE_ACCOUNT_EMAIL, now, now, now);

	db.prepare(
		`
			INSERT INTO account_sync_state (
				account_id, uidvalidity, latest_uid_cursor, earliest_uid_cursor,
				backfill_snapshot_uid, backfill_next_uid, last_bootstrap_started_at,
				last_bootstrap_completed_at, last_delta_sync_at, last_reconcile_at,
				last_backfill_sync_at, backfill_completed_at, last_idle_started_at,
				last_idle_heartbeat_at, watcher_status, consecutive_failures,
				backoff_until, created_at, updated_at
			) VALUES (?, 1, 103, 1, 103, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, 'stopped', 0, NULL, ?, ?)
		`,
	).run(LIVE_ACCOUNT_ID, now, now, now, now, now, now, now, now);

	const insertMessage = db.prepare(
		`
			INSERT INTO messages (
				id, account_id, message_id, thread_key, received_at, sender_name,
				sender_address, to_json, cc_json, subject, in_reply_to,
				body_text_normalized, snippet, attachment_count, has_html,
				raw_byte_start, raw_byte_end, parse_status, token_estimate,
				content_sha256, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, NULL, ?, ?, ?, 0, 0, 0, 'parsed', ?, ?, ?)
		`,
	);

	insertMessage.run(
		BACKLOG_MESSAGE_ID,
		LIVE_ACCOUNT_ID,
		"<playwright-backlog@example.com>",
		"<playwright-backlog@example.com>",
		"2026-04-11T10:00:00.000Z",
		"Vendor Billing",
		"billing@vendor.example",
		BACKLOG_SUBJECT,
		BACKLOG_BODY,
		BACKLOG_BODY.slice(0, 120),
		1,
		Math.ceil(BACKLOG_BODY.length / 4),
		backlogHash,
		now,
	);
	insertMessage.run(
		CLASSIFY_NOW_MESSAGE_ID,
		LIVE_ACCOUNT_ID,
		"<playwright-classify-now@example.com>",
		"<playwright-classify-now@example.com>",
		"2026-04-10T17:00:00.000Z",
		"Friend",
		"friend@example.com",
		CLASSIFY_NOW_SUBJECT,
		CLASSIFY_NOW_BODY,
		CLASSIFY_NOW_BODY.slice(0, 120),
		0,
		Math.ceil(CLASSIFY_NOW_BODY.length / 4),
		classifyNowHash,
		now,
	);
	insertMessage.run(
		REVIEW_MESSAGE_ID,
		LIVE_ACCOUNT_ID,
		"<playwright-review@example.com>",
		"<playwright-review@example.com>",
		"2026-04-09T08:30:00.000Z",
		"Accounting",
		"accounting@example.com",
		REVIEW_SUBJECT,
		REVIEW_BODY,
		REVIEW_BODY.slice(0, 120),
		0,
		Math.ceil(REVIEW_BODY.length / 4),
		reviewHash,
		now,
	);

	db.prepare(
		`
			INSERT INTO attachments (
				id, message_id, filename, mime_type, size_bytes, content_id, is_inline
			) VALUES (?, ?, ?, ?, ?, NULL, 0)
		`,
	).run(
		"playwright-attachment-receipt",
		BACKLOG_MESSAGE_ID,
		"receipt.pdf",
		"application/pdf",
		4096,
	);

	const insertSource = db.prepare(
		`
			INSERT INTO message_sources (
				id, message_id, account_id, remote_message_id, remote_thread_id, mailbox,
				imap_uid, uidvalidity, raw_rfc822_path, raw_sha256, state, first_seen_at,
				last_seen_at, tombstoned_at, updated_at
			) VALUES (?, ?, ?, ?, ?, '[Gmail]/All Mail', ?, 1, ?, ?, ?, ?, ?, ?, ?)
		`,
	);

	insertSource.run(
		"playwright-source-backlog",
		BACKLOG_MESSAGE_ID,
		LIVE_ACCOUNT_ID,
		BACKLOG_REMOTE_ID,
		"810000000000000001",
		101,
		backlogRawPath,
		backlogHash,
		"active",
		now,
		now,
		null,
		now,
	);
	insertSource.run(
		"playwright-source-classify-now",
		CLASSIFY_NOW_MESSAGE_ID,
		LIVE_ACCOUNT_ID,
		CLASSIFY_NOW_REMOTE_ID,
		"810000000000000002",
		102,
		classifyNowRawPath,
		classifyNowHash,
		"active",
		now,
		now,
		null,
		now,
	);
	insertSource.run(
		"playwright-source-review",
		REVIEW_MESSAGE_ID,
		LIVE_ACCOUNT_ID,
		REVIEW_REMOTE_ID,
		"810000000000000003",
		103,
		reviewRawPath,
		reviewHash,
		"tombstoned",
		now,
		now,
		now,
		now,
	);

	db.prepare(
		`
			INSERT INTO classification_results (
				id, job_id, message_id, model, prompt_version, source, result_json,
				raw_response_json, usage_json, low_confidence, created_at, input_content_sha256
			) VALUES (?, NULL, ?, 'gpt-5.4-mini', 'classify-email-v1', 'model', ?, ?, NULL, 1, ?, ?)
		`,
	).run(
		REVIEW_RESULT_ID,
		REVIEW_MESSAGE_ID,
		JSON.stringify(lowConfidenceLabel),
		JSON.stringify({ seeded: true }),
		now,
		reviewHash,
	);

	db.prepare(
		`
			INSERT INTO message_labels (
				message_id, classification_result_id, source, label_json, primary_bucket,
				low_confidence, nsfw, updated_at, content_sha256
			) VALUES (?, ?, 'model', ?, ?, 1, 0, ?, ?)
		`,
	).run(
		REVIEW_MESSAGE_ID,
		REVIEW_RESULT_ID,
		JSON.stringify(lowConfidenceLabel),
		lowConfidenceLabel.routing.primaryBucket,
		now,
		reviewHash,
	);

	db.prepare(
		`
			INSERT INTO reviews (
				id, message_id, source_classification_result_id, status, reviewer_note,
				override_label_json, created_at, resolved_at
			) VALUES (?, ?, ?, 'open', NULL, NULL, ?, NULL)
		`,
	).run(REVIEW_ROW_ID, REVIEW_MESSAGE_ID, REVIEW_RESULT_ID, now);

	db.prepare(
		`
			INSERT INTO overseer_profiles (
				id, account_id, built_from_messages, promoted_tags_json, prompt_preamble,
				profile_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`,
	).run(
		SEEDED_PROFILE_ID,
		LIVE_ACCOUNT_ID,
		seededProfile.builtFromMessages,
		JSON.stringify(seededProfile.promotedTags),
		seededProfile.promptPreamble,
		JSON.stringify(seededProfile),
		now,
	);

	db.close();
}

async function main() {
	const runtimeRoot = resolve(process.cwd(), "test/.runtime/e2e-live");
	const dataDir = resolve(runtimeRoot, "data");

	const hasSubscription =
		Boolean(process.env.OPENAI_API_KEY) ||
		existsSync(resolve(dataDir, "openai-subscription.json")) ||
		existsSync(resolve(process.cwd(), "data/openai-subscription.json"));

	if (!hasSubscription) {
		throw new Error(
			"Live Playwright requires OPENAI_API_KEY or a subscription record at data/openai-subscription.json.",
		);
	}

	await rm(runtimeRoot, { recursive: true, force: true });
	await mkdir(dataDir, { recursive: true });

	const sourceSubscription = resolve(
		process.cwd(),
		"data/openai-subscription.json",
	);
	const targetSubscription = resolve(dataDir, "openai-subscription.json");
	if (existsSync(sourceSubscription)) {
		await cp(sourceSubscription, targetSubscription);
	}

	execFileSync("pnpm", ["db:migrate"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			ZMAIL_DATA_DIR: dataDir,
		},
		stdio: "inherit",
	});

	await seedRuntime(dataDir);
}

export default main;
