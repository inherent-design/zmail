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

	await db
		.insertInto("accounts")
		.values({
			id,
			label: input?.label ?? "Test Account",
			email_address: input?.emailAddress ?? "test@example.com",
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
				email_address: input?.emailAddress ?? "test@example.com",
				sync_enabled: input?.syncEnabled ?? 1,
				sync_status: input?.syncStatus ?? "idle",
				updated_at: nowIso(),
			}),
		)
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

export async function insertMessageRow(
	db: TestDb,
	input?: {
		id?: string;
		accountId?: string;
		messageId?: string;
		senderAddress?: string | null;
		subject?: string | null;
		bodyTextNormalized?: string;
		snippet?: string;
		receivedAt?: string | null;
		parseStatus?: string;
		contentSha256?: string | null;
	},
) {
	const { nowIso } = await import("#/lib/config");
	const id = input?.id ?? randomUUID();
	await db
		.insertInto("messages")
		.values({
			id,
			account_id: input?.accountId ?? "acct-1",
			message_id: input?.messageId ?? `<${id}@example.com>`,
			thread_key: input?.messageId ?? `<${id}@example.com>`,
			received_at:
				input && "receivedAt" in input
					? (input.receivedAt ?? null)
					: "2026-01-01T00:00:00.000Z",
			sender_name: "Sender",
			sender_address:
				input && "senderAddress" in input
					? (input.senderAddress ?? null)
					: "sender@example.com",
			to_json: "[]",
			cc_json: "[]",
			subject:
				input && "subject" in input ? (input.subject ?? null) : "Test message",
			in_reply_to: null,
			body_text_normalized: input?.bodyTextNormalized ?? "hello world",
			snippet: input?.snippet ?? "hello world",
			attachment_count: 0,
			has_html: 0,
			raw_byte_start: 0,
			raw_byte_end: 10,
			parse_status: input?.parseStatus ?? "parsed",
			token_estimate: 3,
			content_sha256:
				input && "contentSha256" in input
					? (input.contentSha256 ?? null)
					: null,
			created_at: nowIso(),
		})
		.execute();
	return id;
}
