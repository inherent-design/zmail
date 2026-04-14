import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import {
	DB_PATH,
	ensureStorageDirs,
	MIGRATIONS_DIR,
	nowIso,
} from "#/lib/config";

interface AccountsTable {
	id: string;
	label: string;
	email_address: string;
	provider_kind: string;
	sync_enabled: number;
	sync_status: string;
	source_truth: string;
	selected_mailbox: string;
	last_synced_at: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

interface AccountSyncStateTable {
	account_id: string;
	uidvalidity: number | null;
	latest_uid_cursor: number | null;
	earliest_uid_cursor: number | null;
	backfill_snapshot_uid: number | null;
	backfill_next_uid: number | null;
	last_bootstrap_started_at: string | null;
	last_bootstrap_completed_at: string | null;
	last_delta_sync_at: string | null;
	last_reconcile_at: string | null;
	last_backfill_sync_at: string | null;
	backfill_completed_at: string | null;
	last_idle_started_at: string | null;
	last_idle_heartbeat_at: string | null;
	watcher_status: string;
	consecutive_failures: number;
	backoff_until: string | null;
	created_at: string;
	updated_at: string;
}

interface MessagesTable {
	id: string;
	account_id: string;
	message_id: string;
	thread_key: string;
	received_at: string | null;
	sender_name: string | null;
	sender_address: string | null;
	to_json: string;
	cc_json: string;
	subject: string | null;
	in_reply_to: string | null;
	body_text_normalized: string;
	snippet: string;
	attachment_count: number;
	has_html: number;
	raw_byte_start: number;
	raw_byte_end: number;
	parse_status: string;
	token_estimate: number;
	content_sha256: string | null;
	created_at: string;
}

interface AttachmentsTable {
	id: string;
	message_id: string;
	filename: string | null;
	mime_type: string | null;
	size_bytes: number;
	content_id: string | null;
	is_inline: number;
}

interface MessageSourcesTable {
	id: string;
	message_id: string;
	account_id: string;
	remote_message_id: string | null;
	remote_thread_id: string | null;
	mailbox: string | null;
	imap_uid: number | null;
	uidvalidity: number | null;
	raw_rfc822_path: string | null;
	raw_sha256: string | null;
	state: string;
	first_seen_at: string;
	last_seen_at: string;
	tombstoned_at: string | null;
	updated_at: string;
}

interface JobsTable {
	id: string;
	kind: string;
	scope_type: string;
	scope_id: string;
	status: string;
	model: string | null;
	prompt_version: string | null;
	request_count: number;
	success_count: number;
	error_count: number;
	claimed_at: string | null;
	lease_expires_at: string | null;
	attempts: number;
	last_error: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	meta_json: string;
}

interface ModerationResultsTable {
	id: string;
	job_id: string | null;
	message_id: string;
	model: string;
	categories_json: string;
	category_scores_json: string;
	raw_response_json: string;
	nsfw_flag: number;
	created_at: string;
}

interface ClassificationResultsTable {
	id: string;
	job_id: string | null;
	message_id: string;
	model: string;
	prompt_version: string;
	source: string;
	result_json: string;
	raw_response_json: string;
	usage_json: string | null;
	low_confidence: number;
	input_content_sha256: string | null;
	created_at: string;
}

interface MessageLabelsTable {
	message_id: string;
	classification_result_id: string;
	source: string;
	label_json: string;
	primary_bucket: string;
	low_confidence: number;
	nsfw: number;
	content_sha256: string | null;
	updated_at: string;
}

interface ReviewsTable {
	id: string;
	message_id: string;
	source_classification_result_id: string;
	status: string;
	reviewer_note: string | null;
	override_label_json: string | null;
	created_at: string;
	resolved_at: string | null;
}

interface OverseerProfilesTable {
	id: string;
	account_id: string;
	built_from_messages: number;
	promoted_tags_json: string;
	prompt_preamble: string;
	profile_json: string;
	created_at: string;
}

export interface DB {
	accounts: AccountsTable;
	account_sync_state: AccountSyncStateTable;
	messages: MessagesTable;
	attachments: AttachmentsTable;
	message_sources: MessageSourcesTable;
	jobs: JobsTable;
	moderation_results: ModerationResultsTable;
	classification_results: ClassificationResultsTable;
	message_labels: MessageLabelsTable;
	reviews: ReviewsTable;
	overseer_profiles: OverseerProfilesTable;
}

declare global {
	var __zmailSqlite__: Database.Database | undefined;
	var __zmailDb__: Kysely<DB> | undefined;
}

export function getSqlite() {
	if (globalThis.__zmailSqlite__) {
		return globalThis.__zmailSqlite__;
	}

	ensureStorageDirs();
	mkdirSync(dirname(DB_PATH), { recursive: true });

	const sqlite = new Database(DB_PATH);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	sqlite.pragma("busy_timeout = 5000");

	globalThis.__zmailSqlite__ = sqlite;
	return sqlite;
}

export function getDb() {
	if (globalThis.__zmailDb__) {
		return globalThis.__zmailDb__;
	}

	const db = new Kysely<DB>({
		dialect: new SqliteDialect({
			database: getSqlite(),
		}),
	});

	globalThis.__zmailDb__ = db;
	return db;
}

export async function resetDb() {
	if (globalThis.__zmailDb__) {
		await globalThis.__zmailDb__.destroy();
		globalThis.__zmailDb__ = undefined;
	}

	if (globalThis.__zmailSqlite__) {
		globalThis.__zmailSqlite__.close();
		globalThis.__zmailSqlite__ = undefined;
	}
}

function getTableColumns(sqlite: Database.Database, tableName: string) {
	return new Set(
		(
			sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
}

function hasTableColumns(
	sqlite: Database.Database,
	tableName: string,
	requiredColumns: string[],
) {
	const columns = getTableColumns(sqlite, tableName);
	return requiredColumns.every((column) => columns.has(column));
}

function lacksTableColumns(
	sqlite: Database.Database,
	tableName: string,
	forbiddenColumns: string[],
) {
	const columns = getTableColumns(sqlite, tableName);
	return forbiddenColumns.every((column) => !columns.has(column));
}

function isMigrationAlreadyReflected(sqlite: Database.Database, file: string) {
	switch (file) {
		case "002_jobs_live_cleanup.sql":
			return (
				hasTableColumns(sqlite, "jobs", [
					"id",
					"kind",
					"scope_type",
					"scope_id",
					"status",
					"model",
					"prompt_version",
					"request_count",
					"success_count",
					"error_count",
					"claimed_at",
					"lease_expires_at",
					"attempts",
					"last_error",
					"created_at",
					"started_at",
					"finished_at",
					"meta_json",
				]) &&
				lacksTableColumns(sqlite, "jobs", [
					"batch_id",
					"input_file_path",
					"output_file_path",
					"error_file_path",
				])
			);
		case "003_account_sync_state_resumable_backfill.sql":
			return (
				hasTableColumns(sqlite, "account_sync_state", [
					"latest_uid_cursor",
					"earliest_uid_cursor",
					"backfill_snapshot_uid",
					"backfill_next_uid",
					"last_bootstrap_started_at",
					"last_bootstrap_completed_at",
					"last_backfill_sync_at",
					"backfill_completed_at",
				]) &&
				lacksTableColumns(sqlite, "account_sync_state", [
					"last_seen_uid",
					"last_full_sync_started_at",
					"last_full_sync_completed_at",
				])
			);
		default:
			return false;
	}
}

export function runMigrations() {
	const sqlite = getSqlite();
	sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

	const files = readdirSync(MIGRATIONS_DIR)
		.filter((entry) => entry.endsWith(".sql"))
		.sort();

	const applied = new Set(
		sqlite
			.prepare("SELECT name FROM _migrations ORDER BY name")
			.all()
			.map((row) => String((row as { name: string }).name)),
	);
	const insertMigration = sqlite.prepare(
		"INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
	);

	for (const file of files) {
		if (applied.has(file)) {
			continue;
		}
		if (isMigrationAlreadyReflected(sqlite, file)) {
			insertMigration.run(file, nowIso());
			applied.add(file);
			continue;
		}
		const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
		sqlite.exec(sql);
		insertMigration.run(file, nowIso());
		applied.add(file);
	}
}

export function safeJsonParse<T>(value: string | null, fallback: T): T {
	if (!value) {
		return fallback;
	}

	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function jsonText(value: unknown) {
	return JSON.stringify(value);
}

export function fileName(path: string) {
	return basename(path);
}
