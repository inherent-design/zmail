import { createServerFn } from "@tanstack/react-start";

import { APP_CONFIG, OVERSEER_PROMPT_VERSION } from "#/lib/config";
import { type LogFields, type LogTrace, startTrace } from "#/lib/log";
import {
	accountIdInputSchema,
	beginGoogleConnectInputSchema,
	classifyOneInputSchema,
	enqueueOverseerInputSchema,
	messageLabelSchema,
	resolveReviewInputSchema,
} from "#/lib/schemas";

let bootServerOnce: Promise<typeof import("#/lib/db")> | null = null;

async function bootServer() {
	if (!bootServerOnce) {
		bootServerOnce = (async () => {
			const [{ ensureWorkerStarted }, dbModule] = await Promise.all([
				import("#/lib/worker"),
				import("#/lib/db"),
			]);
			dbModule.runMigrations();
			ensureWorkerStarted();
			return dbModule;
		})().catch((error) => {
			bootServerOnce = null;
			throw error;
		});
	}

	return bootServerOnce;
}

async function runLoggedAction<TResult>(input: {
	operation: string;
	kind: "loader" | "command";
	context?: LogFields;
	run: (trace: LogTrace) => Promise<TResult>;
	summarize?: (result: TResult) => LogFields;
}) {
	const trace = startTrace({
		kind: input.kind,
		operation: input.operation,
		...(input.context ?? {}),
	});
	trace.info("server.action.start");

	try {
		const result = await input.run(trace);
		trace.complete("server.action.complete", input.summarize?.(result));
		return result;
	} catch (error) {
		trace.fail("server.action.fail", error);
		throw error;
	}
}

async function assertRemoteSyncCommandAllowed(accountId: string) {
	const { getDb } = await bootServer();
	const db = getDb();
	const account = await db
		.selectFrom("accounts")
		.select(["id", "sync_enabled", "sync_status"])
		.where("id", "=", accountId)
		.executeTakeFirstOrThrow();

	if (account.sync_enabled !== 1) {
		throw new Error(
			"Remote sync is disabled for this account. Resume the account before running remote sync.",
		);
	}

	return { db, account };
}

export async function loadHomeData() {
	return runLoggedAction({
		operation: "loadHomeData",
		kind: "loader",
		run: async () => {
			const { getDb } = await bootServer();
			const db = getDb();
			const [messages, reviews, jobs, accounts] = await Promise.all([
				db
					.selectFrom("messages")
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.executeTakeFirstOrThrow(),
				db
					.selectFrom("reviews")
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.where("status", "=", "open")
					.executeTakeFirstOrThrow(),
				db
					.selectFrom("jobs")
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.executeTakeFirstOrThrow(),
				db
					.selectFrom("accounts")
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.executeTakeFirstOrThrow(),
			]);

			return {
				messages: Number(messages.count),
				openReviews: Number(reviews.count),
				jobs: Number(jobs.count),
				accounts: Number(accounts.count),
			};
		},
		summarize: (result) => ({
			messages: result.messages,
			open_reviews: result.openReviews,
			jobs: result.jobs,
			accounts: result.accounts,
		}),
	});
}

export async function loadMessagesData() {
	return runLoggedAction({
		operation: "loadMessagesData",
		kind: "loader",
		run: async () => {
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			const rows = await db
				.selectFrom("messages")
				.leftJoin("message_labels", "message_labels.message_id", "messages.id")
				.innerJoin("accounts", "accounts.id", "messages.account_id")
				.select([
					"messages.id",
					"messages.received_at",
					"messages.sender_address",
					"messages.subject",
					"accounts.label as account_label",
					"message_labels.primary_bucket",
					"message_labels.low_confidence",
					"message_labels.nsfw",
					"message_labels.label_json",
				])
				.orderBy("messages.received_at", "desc")
				.limit(250)
				.execute();

			return rows.map((row) => ({
				...row,
				label: safeJsonParse(row.label_json ?? null, null),
			}));
		},
		summarize: (result) => ({
			count: result.length,
		}),
	});
}

export async function loadMessageDetailData(input: { messageId: string }) {
	return runLoggedAction({
		operation: "loadMessageDetailData",
		kind: "loader",
		context: {
			message_id: input.messageId,
		},
		run: async (trace) => {
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			const message = await db
				.selectFrom("messages")
				.innerJoin("accounts", "accounts.id", "messages.account_id")
				.select([
					"messages.id",
					"messages.account_id",
					"accounts.label as account_label",
					"messages.message_id",
					"messages.thread_key",
					"messages.received_at",
					"messages.sender_name",
					"messages.sender_address",
					"messages.to_json",
					"messages.cc_json",
					"messages.subject",
					"messages.in_reply_to",
					"messages.body_text_normalized",
					"messages.snippet",
					"messages.attachment_count",
					"messages.has_html",
					"messages.parse_status",
					"messages.token_estimate",
				])
				.where("messages.id", "=", input.messageId)
				.executeTakeFirstOrThrow();
			trace.add({
				account_id: message.account_id,
			});

			const attachments = await db
				.selectFrom("attachments")
				.selectAll()
				.where("message_id", "=", input.messageId)
				.execute();

			const moderation = await db
				.selectFrom("moderation_results")
				.selectAll()
				.where("message_id", "=", input.messageId)
				.executeTakeFirst();

			const classifications = await db
				.selectFrom("classification_results")
				.selectAll()
				.where("message_id", "=", input.messageId)
				.orderBy("created_at", "desc")
				.execute();

			const currentLabel = await db
				.selectFrom("message_labels")
				.selectAll()
				.where("message_id", "=", input.messageId)
				.executeTakeFirst();

			const latestProfile = await db
				.selectFrom("overseer_profiles")
				.select(["profile_json"])
				.where("account_id", "=", message.account_id)
				.orderBy("created_at", "desc")
				.executeTakeFirst();

			return {
				message: {
					...message,
					to: safeJsonParse(message.to_json, []),
					cc: safeJsonParse(message.cc_json, []),
				},
				attachments,
				moderation: moderation
					? {
							...moderation,
							categories: safeJsonParse(moderation.categories_json, {}),
							categoryScores: safeJsonParse(
								moderation.category_scores_json,
								{},
							),
						}
					: null,
				classifications: classifications.map((row) => ({
					...row,
					result: safeJsonParse(row.result_json, null),
					usage: safeJsonParse(row.usage_json, null),
				})),
				currentLabel: currentLabel
					? {
							...currentLabel,
							label: safeJsonParse(currentLabel.label_json, null),
						}
					: null,
				latestProfile: latestProfile
					? safeJsonParse(latestProfile.profile_json, null)
					: null,
			};
		},
		summarize: (result) => ({
			account_id: result.message.account_id,
			attachments: result.attachments.length,
			classifications: result.classifications.length,
			has_moderation: Boolean(result.moderation),
			has_current_label: Boolean(result.currentLabel),
			has_latest_profile: Boolean(result.latestProfile),
		}),
	});
}

export async function loadReviewData() {
	return runLoggedAction({
		operation: "loadReviewData",
		kind: "loader",
		run: async () => {
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			const rows = await db
				.selectFrom("reviews")
				.innerJoin("messages", "messages.id", "reviews.message_id")
				.innerJoin(
					"classification_results",
					"classification_results.id",
					"reviews.source_classification_result_id",
				)
				.select([
					"reviews.id",
					"reviews.status",
					"reviews.created_at",
					"messages.id as message_id",
					"messages.sender_address",
					"messages.subject",
					"messages.snippet",
					"classification_results.result_json",
				])
				.where("reviews.status", "=", "open")
				.orderBy("reviews.created_at", "asc")
				.execute();

			return rows.map((row) => ({
				...row,
				result: safeJsonParse(row.result_json, null),
			}));
		},
		summarize: (result) => ({
			count: result.length,
		}),
	});
}

export async function loadRunsData() {
	return runLoggedAction({
		operation: "loadRunsData",
		kind: "loader",
		run: async () => {
			const [{ listJobs }, { getPiStatus }] = await Promise.all([
				import("#/lib/jobs"),
				import("#/lib/pi"),
			]);
			await bootServer();
			const [jobs, runtime] = await Promise.all([listJobs(), getPiStatus()]);
			return {
				jobs,
				runtime,
			};
		},
		summarize: (result) => ({
			jobs: result.jobs.length,
			resolved_backend: result.runtime.resolvedBackend ?? "unavailable",
		}),
	});
}

export async function loadProfileData(input: { accountId: string }) {
	return runLoggedAction({
		operation: "loadProfileData",
		kind: "loader",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { getDb, safeJsonParse } = await bootServer();
			const db = getDb();
			const account = await db
				.selectFrom("accounts")
				.selectAll()
				.where("id", "=", input.accountId)
				.executeTakeFirstOrThrow();
			const profiles = await db
				.selectFrom("overseer_profiles")
				.selectAll()
				.where("account_id", "=", input.accountId)
				.orderBy("created_at", "desc")
				.execute();
			return {
				account,
				profiles: profiles.map((profile) => ({
					...profile,
					profile: safeJsonParse(profile.profile_json, null),
					promotedTags: safeJsonParse(profile.promoted_tags_json, []),
				})),
			};
		},
		summarize: (result) => ({
			profiles: result.profiles.length,
		}),
	});
}

export async function enqueueOverseerCommand(input: { accountId: string }) {
	return runLoggedAction({
		operation: "enqueueOverseerCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await bootServer();
			const { queueJob } = await import("#/lib/jobs");
			return queueJob({
				kind: "rebuild_overseer",
				scopeType: "account",
				scopeId: input.accountId,
				model: APP_CONFIG.fallbackModel,
				promptVersion: OVERSEER_PROMPT_VERSION,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function resolveReviewCommand(input: {
	reviewId: string;
	action: "accept" | "override";
	override?: unknown;
	note?: string;
}) {
	return runLoggedAction({
		operation: "resolveReviewCommand",
		kind: "command",
		context: {
			review_id: input.reviewId,
			review_action: input.action,
		},
		run: async (trace) => {
			const [{ getDb }, { nowIso }] = await Promise.all([
				import("#/lib/db"),
				import("#/lib/config"),
			]);
			await bootServer();
			const db = getDb();

			const review = await db
				.selectFrom("reviews")
				.select(["message_id"])
				.where("id", "=", input.reviewId)
				.executeTakeFirstOrThrow();
			trace.add({
				message_id: review.message_id,
			});

			if (input.action === "accept") {
				await db
					.updateTable("reviews")
					.set({
						status: "resolved",
						reviewer_note: input.note ?? null,
						resolved_at: nowIso(),
					})
					.where("id", "=", input.reviewId)
					.execute();
				return { status: "accepted" as const };
			}

			if (!input.override) {
				throw new Error("Override label is required for override action");
			}

			const { writeManualOverride } = await import("#/lib/classify");
			await writeManualOverride({
				reviewId: input.reviewId,
				messageId: review.message_id,
				note: input.note ?? null,
				label: messageLabelSchema.parse(input.override),
			});
			return { status: "overridden" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export async function classifyOneNowCommand(input: { messageId: string }) {
	return runLoggedAction({
		operation: "classifyOneNowCommand",
		kind: "command",
		context: {
			message_id: input.messageId,
		},
		run: async (trace) => {
			const { getDb } = await bootServer();
			const db = getDb();
			const message = await db
				.selectFrom("messages")
				.innerJoin("accounts", "accounts.id", "messages.account_id")
				.select([
					"messages.id",
					"messages.account_id",
					"accounts.label as account_label",
					"messages.sender_address",
					"messages.subject",
					"messages.received_at",
					"messages.body_text_normalized",
				])
				.where("messages.id", "=", input.messageId)
				.executeTakeFirstOrThrow();
			trace.add({
				account_id: message.account_id,
			});

			const attachments = await db
				.selectFrom("attachments")
				.select(["filename", "mime_type"])
				.where("message_id", "=", input.messageId)
				.execute();

			const [
				{ ensureModerationForMessage, topModerationScores },
				classifyModule,
				overseer,
			] = await Promise.all([
				import("#/lib/moderation"),
				import("#/lib/classify"),
				import("#/lib/overseer"),
			]);

			const moderation = await ensureModerationForMessage({
				jobId: null,
				messageId: message.id,
				sender: message.sender_address ?? "(unknown)",
				subject: message.subject ?? "(no subject)",
				bodyText: message.body_text_normalized,
			});

			const context = await overseer.loadLatestOverseerContext(
				message.account_id,
			);

			await classifyModule.classifyMessageNow({
				jobId: null,
				messageId: message.id,
				accountLabel: message.account_label,
				sender: message.sender_address ?? "(unknown)",
				subject: message.subject ?? "(no subject)",
				receivedAt: message.received_at ?? "(unknown)",
				bodyText: message.body_text_normalized,
				attachmentsSummary: classifyModule.buildAttachmentSummary(attachments),
				moderationFlag: moderation.nsfwFlag,
				moderationScores: topModerationScores(moderation.scores),
				promptPreamble: context.promptPreamble,
				allowedTags: classifyModule.mergeAllowedTags(context.promotedTags),
			});

			return { status: "classified" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export const getHomeData = createServerFn({ method: "GET" }).handler(
	loadHomeData,
);

export const getMessagesData = createServerFn({ method: "GET" }).handler(
	loadMessagesData,
);

export const getMessageDetailData = createServerFn({
	method: "GET",
})
	.inputValidator(classifyOneInputSchema)
	.handler(async ({ data }) => loadMessageDetailData(data));

export const getReviewData = createServerFn({ method: "GET" }).handler(
	loadReviewData,
);

export const getRunsData = createServerFn({ method: "GET" }).handler(
	loadRunsData,
);

export const getProfileData = createServerFn({
	method: "GET",
})
	.inputValidator(enqueueOverseerInputSchema.pick({ accountId: true }))
	.handler(async ({ data }) => loadProfileData(data));

export const enqueueOverseer = createServerFn({
	method: "POST",
})
	.inputValidator(enqueueOverseerInputSchema)
	.handler(async ({ data }) => enqueueOverseerCommand(data));

export const resolveReview = createServerFn({
	method: "POST",
})
	.inputValidator(resolveReviewInputSchema)
	.handler(async ({ data }) => resolveReviewCommand(data));

export const classifyOneNow = createServerFn({
	method: "POST",
})
	.inputValidator(classifyOneInputSchema)
	.handler(async ({ data }) => classifyOneNowCommand(data));

export async function loadAccountsData() {
	return runLoggedAction({
		operation: "loadAccountsData",
		kind: "loader",
		run: async () => {
			const { getDb } = await bootServer();
			const db = getDb();
			const [accounts, messageCounts, tombstoneCounts] = await Promise.all([
				db.selectFrom("accounts").selectAll().orderBy("label").execute(),
				db
					.selectFrom("messages")
					.select(["account_id", (eb) => eb.fn.countAll<number>().as("count")])
					.groupBy("account_id")
					.execute(),
				db
					.selectFrom("message_sources")
					.select(["account_id", (eb) => eb.fn.countAll<number>().as("count")])
					.where("state", "=", "tombstoned")
					.groupBy("account_id")
					.execute(),
			]);

			const messageCountsByAccount = new Map(
				messageCounts.map((row) => [row.account_id, Number(row.count)]),
			);
			const tombstoneCountsByAccount = new Map(
				tombstoneCounts.map((row) => [row.account_id, Number(row.count)]),
			);

			return {
				accounts: accounts.map((account) => ({
					...account,
					message_count: messageCountsByAccount.get(account.id) ?? 0,
					tombstone_count: tombstoneCountsByAccount.get(account.id) ?? 0,
				})),
			};
		},
		summarize: (result) => ({
			accounts: result.accounts.length,
		}),
	});
}

export async function loadAccountNewData() {
	return runLoggedAction({
		operation: "loadAccountNewData",
		kind: "loader",
		run: async () => {
			await bootServer();
			const [{ isOAuthConfigured, missingOAuthVars }, { GOOGLE_OAUTH }] =
				await Promise.all([
					import("#/lib/google-oauth"),
					import("#/lib/config"),
				]);
			return {
				oauthReady: isOAuthConfigured(),
				missingVars: missingOAuthVars(),
				redirectUrl: GOOGLE_OAUTH.redirectUrl,
			};
		},
		summarize: (result) => ({
			oauth_ready: result.oauthReady,
			missing_vars: result.missingVars.length,
		}),
	});
}

export async function loadAccountDetailData(input: { accountId: string }) {
	return runLoggedAction({
		operation: "loadAccountDetailData",
		kind: "loader",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { getDb } = await bootServer();
			const db = getDb();
			const account = await db
				.selectFrom("accounts")
				.selectAll()
				.where("id", "=", input.accountId)
				.executeTakeFirstOrThrow();

			const syncState = await db
				.selectFrom("account_sync_state")
				.selectAll()
				.where("account_id", "=", input.accountId)
				.executeTakeFirst();

			const recentJobs = await db
				.selectFrom("jobs")
				.select(["id", "kind", "status", "created_at", "last_error"])
				.where("scope_type", "=", "account")
				.where("scope_id", "=", input.accountId)
				.orderBy("created_at", "desc")
				.limit(10)
				.execute();

			const msgCount = await db
				.selectFrom("messages")
				.select((eb) => eb.fn.countAll<number>().as("count"))
				.where("account_id", "=", input.accountId)
				.executeTakeFirstOrThrow();

			const tombCount = await db
				.selectFrom("message_sources")
				.select((eb) => eb.fn.countAll<number>().as("count"))
				.where("account_id", "=", input.accountId)
				.where("state", "=", "tombstoned")
				.executeTakeFirstOrThrow();

			return {
				account,
				syncState: syncState ?? null,
				recentJobs,
				messageCount: Number(msgCount.count),
				tombstoneCount: Number(tombCount.count),
			};
		},
		summarize: (result) => ({
			message_count: result.messageCount,
			tombstone_count: result.tombstoneCount,
			recent_jobs: result.recentJobs.length,
			has_sync_state: Boolean(result.syncState),
		}),
	});
}

export async function beginGoogleConnectCommand(input: { label: string }) {
	return runLoggedAction({
		operation: "beginGoogleConnectCommand",
		kind: "command",
		run: async () => {
			await bootServer();
			const { buildAuthUrl } = await import("#/lib/google-oauth");
			return buildAuthUrl(input.label);
		},
		summarize: () => ({
			oauth_redirect_prepared: true,
		}),
	});
}

export async function completeGoogleConnectCommand(input: {
	code: string;
	state: string;
}) {
	return runLoggedAction({
		operation: "completeGoogleConnectCommand",
		kind: "command",
		run: async (trace) => {
			const [{ getDb }, { nowIso }] = await Promise.all([
				bootServer(),
				import("#/lib/config"),
			]);
			const db = getDb();
			const oauth = await import("#/lib/google-oauth");

			const oauthState = oauth.loadOAuthState(input.state);
			if (!oauthState) {
				throw new Error("Invalid or expired OAuth state");
			}

			const tokens = await oauth.exchangeCode(
				input.code,
				oauthState.codeVerifier,
			);
			const normalizedEmail = (
				await oauth.fetchEmailIdentity(tokens.access_token)
			)
				.trim()
				.toLowerCase();
			const record = oauth.buildOAuthRecord(normalizedEmail, tokens);
			const now = nowIso();

			const accounts = await db.selectFrom("accounts").selectAll().execute();
			const existingAccount = accounts.find(
				(account) =>
					account.email_address.trim().toLowerCase() === normalizedEmail,
			);

			const accountId = existingAccount?.id ?? crypto.randomUUID();
			trace.add({
				account_id: accountId,
			});
			const selectedMailbox =
				existingAccount?.selected_mailbox?.trim() || "[Gmail]/All Mail";

			if (existingAccount) {
				await db
					.updateTable("accounts")
					.set({
						label: oauthState.label,
						email_address: normalizedEmail,
						provider_kind: "gmail",
						sync_enabled: 1,
						sync_status: "idle",
						source_truth: "corpus_mirror",
						selected_mailbox: selectedMailbox,
						last_error: null,
						updated_at: now,
					})
					.where("id", "=", accountId)
					.execute();
			} else {
				await db
					.insertInto("accounts")
					.values({
						id: accountId,
						label: oauthState.label,
						email_address: normalizedEmail,
						provider_kind: "gmail",
						sync_enabled: 1,
						sync_status: "idle",
						source_truth: "corpus_mirror",
						selected_mailbox: selectedMailbox,
						last_synced_at: null,
						last_error: null,
						created_at: now,
						updated_at: now,
					})
					.execute();
			}

			oauth.writeOAuthToken(accountId, record);

			await db
				.insertInto("account_sync_state")
				.values({
					account_id: accountId,
					uidvalidity: null,
					latest_uid_cursor: null,
					earliest_uid_cursor: null,
					backfill_snapshot_uid: null,
					backfill_next_uid: null,
					last_bootstrap_started_at: null,
					last_bootstrap_completed_at: null,
					last_delta_sync_at: null,
					last_reconcile_at: null,
					last_backfill_sync_at: null,
					backfill_completed_at: null,
					last_idle_started_at: null,
					last_idle_heartbeat_at: null,
					watcher_status: "stopped",
					consecutive_failures: 0,
					backoff_until: null,
					created_at: now,
					updated_at: now,
				})
				.onConflict((oc) =>
					oc.column("account_id").doUpdateSet({
						updated_at: now,
					}),
				)
				.execute();

			const { queueJobIdempotent } = await import("#/lib/jobs");
			await queueJobIdempotent({
				kind: "sync_account_full",
				scopeType: "account",
				scopeId: accountId,
			});

			return { accountId };
		},
		summarize: (result) => ({
			account_id: result.accountId,
		}),
	});
}

export async function queueAccountFullSyncCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueAccountFullSyncCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await assertRemoteSyncCommandAllowed(input.accountId);
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "sync_account_full",
				scopeType: "account",
				scopeId: input.accountId,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueAccountDeltaSyncCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueAccountDeltaSyncCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await assertRemoteSyncCommandAllowed(input.accountId);
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "sync_account_delta",
				scopeType: "account",
				scopeId: input.accountId,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueAccountReconcileCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueAccountReconcileCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await assertRemoteSyncCommandAllowed(input.accountId);
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "sync_account_reconcile",
				scopeType: "account",
				scopeId: input.accountId,
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function queueAccountClassifyBacklogCommand(input: {
	accountId: string;
}) {
	return runLoggedAction({
		operation: "queueAccountClassifyBacklogCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			await bootServer();
			const { queueJobIdempotent } = await import("#/lib/jobs");
			return queueJobIdempotent({
				kind: "classify_account_backlog",
				scopeType: "account",
				scopeId: input.accountId,
				model: process.env.ZMAIL_CLASSIFIER_MODEL ?? "gpt-5.4-mini",
				promptVersion: "classify-email-v1",
			});
		},
		summarize: (result) => ({
			job_id: result,
		}),
	});
}

export async function pauseAccountSyncCommand(input: { accountId: string }) {
	return runLoggedAction({
		operation: "pauseAccountSyncCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { getDb } = await bootServer();
			const { nowIso } = await import("#/lib/config");
			const { stopWatcher } = await import("#/lib/watchers");
			const db = getDb();
			await stopWatcher(input.accountId);
			await db
				.updateTable("accounts")
				.set({
					sync_enabled: 0,
					sync_status: "paused",
					updated_at: nowIso(),
				})
				.where("id", "=", input.accountId)
				.execute();
			return { status: "paused" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export async function resumeAccountSyncCommand(input: { accountId: string }) {
	return runLoggedAction({
		operation: "resumeAccountSyncCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { getDb } = await bootServer();
			const { nowIso } = await import("#/lib/config");
			const { queueJobIdempotent } = await import("#/lib/jobs");
			const { startWatcher } = await import("#/lib/watchers");
			const db = getDb();
			const syncState = await db
				.selectFrom("account_sync_state")
				.select([
					"backfill_next_uid",
					"last_bootstrap_completed_at",
					"account_id",
				])
				.where("account_id", "=", input.accountId)
				.executeTakeFirst();
			const nextStatus =
				syncState?.backfill_next_uid !== null &&
				syncState?.backfill_next_uid !== undefined
					? "backfilling"
					: "idle";
			await db
				.updateTable("accounts")
				.set({
					sync_enabled: 1,
					sync_status: nextStatus,
					updated_at: nowIso(),
				})
				.where("id", "=", input.accountId)
				.execute();

			if (!syncState || syncState.last_bootstrap_completed_at === null) {
				await queueJobIdempotent({
					kind: "sync_account_full",
					scopeType: "account",
					scopeId: input.accountId,
				});
			} else {
				await startWatcher(input.accountId);
				if (syncState.backfill_next_uid !== null) {
					await queueJobIdempotent({
						kind: "sync_account_backfill",
						scopeType: "account",
						scopeId: input.accountId,
					});
				}
			}
			return { status: "resumed" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export async function disconnectAccountCommand(input: { accountId: string }) {
	return runLoggedAction({
		operation: "disconnectAccountCommand",
		kind: "command",
		context: {
			account_id: input.accountId,
		},
		run: async () => {
			const { getDb } = await bootServer();
			const { nowIso } = await import("#/lib/config");
			const { stopWatcher } = await import("#/lib/watchers");
			const { deleteOAuthToken } = await import("#/lib/google-oauth");
			const db = getDb();
			await stopWatcher(input.accountId);
			deleteOAuthToken(input.accountId);
			await db
				.updateTable("accounts")
				.set({
					sync_enabled: 0,
					sync_status: "idle",
					last_error: null,
					updated_at: nowIso(),
				})
				.where("id", "=", input.accountId)
				.execute();
			return { status: "disconnected" as const };
		},
		summarize: (result) => ({
			status: result.status,
		}),
	});
}

export const getAccountsData = createServerFn({ method: "GET" }).handler(
	loadAccountsData,
);

export const getAccountNewData = createServerFn({ method: "GET" }).handler(
	loadAccountNewData,
);

export const getAccountDetailData = createServerFn({
	method: "GET",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => loadAccountDetailData(data));

export const beginGoogleConnect = createServerFn({
	method: "POST",
})
	.inputValidator(beginGoogleConnectInputSchema)
	.handler(async ({ data }) => beginGoogleConnectCommand(data));

export const queueAccountFullSync = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueAccountFullSyncCommand(data));

export const queueAccountDeltaSync = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueAccountDeltaSyncCommand(data));

export const queueAccountReconcile = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueAccountReconcileCommand(data));

export const queueAccountClassifyBacklog = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => queueAccountClassifyBacklogCommand(data));

export const pauseAccountSync = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => pauseAccountSyncCommand(data));

export const resumeAccountSync = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => resumeAccountSyncCommand(data));

export const disconnectAccount = createServerFn({
	method: "POST",
})
	.inputValidator(accountIdInputSchema)
	.handler(async ({ data }) => disconnectAccountCommand(data));
