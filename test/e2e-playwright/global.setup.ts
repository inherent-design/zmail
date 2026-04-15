import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
	PLAYWRIGHT_SCENARIOS,
	buildFinanceScenarioIntel,
	buildSeededReviewLabel,
} from "./scenarios";
import { buildMessageLabelV2 } from "#/test/helpers/labels";

function sha256(input: string) {
	return createHash("sha256").update(input).digest("hex");
}

function buildRawMessage(input: {
	subject: string;
	senderAddress: string;
	body: string;
}) {
	return `Subject: ${input.subject}\nFrom: ${input.senderAddress}\n\n${input.body}\n`;
}

async function writeRawMessage(input: {
	dataDir: string;
	accountId: string;
	remoteId: string;
	subject: string;
	senderAddress: string;
	body: string;
}) {
	const rawDir = resolve(input.dataDir, "accounts", input.accountId, "raw");
	await mkdir(rawDir, { recursive: true });
	const rawPath = resolve(rawDir, `${input.remoteId}.eml`);
	const raw = buildRawMessage(input);
	await writeFile(rawPath, raw);
	return {
		rawPath,
		rawSha256: sha256(raw),
	};
}

async function seedRuntime(dataDir: string) {
	process.env.ZMAIL_DATA_DIR = dataDir;

	const [
		{ buildContentSha256 },
		{
			bootDb,
			insertAccountSyncStateRow,
			insertAttachmentRow,
			insertConversationRow,
			insertMessageLabelRow,
			insertMessageRow,
			insertMessageSourceRow,
			insertReviewRow,
			insertSecondaryResultRow,
			seedTestAccount,
		},
		{ writeOAuthToken },
	] = await Promise.all([
		import("#/lib/normalize"),
		import("#/test/helpers/db"),
		import("#/lib/google-oauth"),
	]);

	const { db } = await bootDb();
	const now = new Date().toISOString();

	async function seedAccount(input: {
		id: string;
		label: string;
		email: string;
		syncEnabled: number;
		syncStatus:
			| "idle"
			| "syncing"
			| "backfilling"
			| "needs_reconnect"
			| "resync_required"
			| "paused"
			| "error";
		hasOAuthToken: boolean;
	}) {
		await seedTestAccount(db, {
			id: input.id,
			label: input.label,
			emailAddress: input.email,
			syncEnabled: input.syncEnabled,
			syncStatus: input.syncStatus,
		});
		await insertAccountSyncStateRow(db, {
			accountId: input.id,
			uidvalidity: 1,
			latestUidCursor: 100,
			earliestUidCursor: 1,
			watcherStatus: "stopped",
		});
		if (input.hasOAuthToken) {
			writeOAuthToken(input.id, {
				version: 1,
				provider: "google",
				emailAddress: input.email,
				accessToken: `token-${input.id}`,
				refreshToken: `refresh-${input.id}`,
				expiresAt: "2099-01-01T00:00:00.000Z",
				scope: ["openid", "email"],
				tokenType: "Bearer",
				updatedAt: now,
			});
		}
	}

	async function seedMessage(input: {
		accountId: string;
		message: {
			id: string;
			remoteId: string;
			subject: string;
			body: string;
			senderName: string;
			senderAddress: string;
			receivedAt: string;
			attachmentName?: string;
		};
		label?:
			| {
					label: Record<string, unknown>;
					lowConfidence?: number;
			  }
			| undefined;
		review?:
			| {
					id: string;
					sourceClassificationResultId: string;
			  }
			| undefined;
		financeResult?: Record<string, unknown>;
	}) {
		const conversationId = `conversation-${input.message.id}`;
		await insertConversationRow(db, {
			id: conversationId,
			accountId: input.accountId,
			gmailThreadId: `thread-${input.message.remoteId}`,
			firstMessageReceivedAt: input.message.receivedAt,
			lastMessageReceivedAt: input.message.receivedAt,
			messageCount: 1,
		});

		const attachmentSummary = input.message.attachmentName
			? [
					{
						filename: input.message.attachmentName,
						mime_type: "application/pdf",
					},
				]
			: [];
		const contentSha256 = buildContentSha256({
			senderAddress: input.message.senderAddress,
			subject: input.message.subject,
			receivedAt: input.message.receivedAt,
			bodyTextNormalized: input.message.body,
			attachments: attachmentSummary,
		});
		const messageId = await insertMessageRow(db, {
			id: input.message.id,
			accountId: input.accountId,
			messageId: `<${input.message.id}@example.com>`,
			senderAddress: input.message.senderAddress,
			subject: input.message.subject,
			bodyTextPrimary: input.message.body,
			bodyTextNormalized: input.message.body,
			snippet: input.message.body.slice(0, 120),
			receivedAt: input.message.receivedAt,
			conversationId,
			contentSha256,
		});
		if (input.message.attachmentName) {
			await insertAttachmentRow(db, {
				id: `attachment-${input.message.id}`,
				messageId,
				filename: input.message.attachmentName,
				mimeType: "application/pdf",
				sizeBytes: 4096,
			});
		}
		const { rawPath, rawSha256 } = await writeRawMessage({
			dataDir,
			accountId: input.accountId,
			remoteId: input.message.remoteId,
			subject: input.message.subject,
			senderAddress: input.message.senderAddress,
			body: input.message.body,
		});
		await insertMessageSourceRow(db, {
			id: `source-${input.message.id}`,
			messageId,
			accountId: input.accountId,
			remoteMessageId: input.message.remoteId,
			remoteThreadId: `thread-${input.message.remoteId}`,
			imapUid: Number.parseInt(input.message.remoteId.slice(-3), 10),
			uidvalidity: 1,
			rawRfc822Path: rawPath,
			rawSha256,
			state: "active",
			firstSeenAt: now,
			lastSeenAt: now,
			updatedAt: now,
		});

		if (input.label) {
			await insertMessageLabelRow(db, {
				messageId,
				primaryBucket:
					typeof input.label.label.routing === "object" &&
					input.label.label.routing !== null &&
					"primaryBucket" in input.label.label.routing
						? String(
								(input.label.label.routing as { primaryBucket?: string })
									.primaryBucket ?? "other",
							)
						: "other",
				lowConfidence: input.label.lowConfidence ?? 0,
				contentSha256,
				label: input.label.label,
			});
		}

		if (input.review) {
			await insertReviewRow(db, {
				id: input.review.id,
				messageId,
				sourceClassificationResultId: input.review.sourceClassificationResultId,
				status: "open",
				createdAt: now,
			});
		}

		if (input.financeResult) {
			await insertSecondaryResultRow(db, {
				messageId,
				classifierKey: "finance_intel",
				status: "ready",
				contentSha256,
				registrySha256: null,
				result: input.financeResult,
			});
		}

		return {
			messageId,
			contentSha256,
		};
	}

	for (const scenario of Object.values(PLAYWRIGHT_SCENARIOS)) {
		await seedAccount(scenario.account);
	}

	await seedMessage({
		accountId: PLAYWRIGHT_SCENARIOS.backlog.account.id,
		message: PLAYWRIGHT_SCENARIOS.backlog.message,
	});
	await seedMessage({
		accountId: PLAYWRIGHT_SCENARIOS.classifyNow.account.id,
		message: PLAYWRIGHT_SCENARIOS.classifyNow.message,
	});
	await seedMessage({
		accountId: PLAYWRIGHT_SCENARIOS.review.account.id,
		message: PLAYWRIGHT_SCENARIOS.review.message,
		label: {
			label: buildSeededReviewLabel(),
			lowConfidence: 1,
		},
		review: {
			id: PLAYWRIGHT_SCENARIOS.review.reviewId,
			sourceClassificationResultId: `classification-${PLAYWRIGHT_SCENARIOS.review.message.id}`,
		},
	});
	await seedMessage({
		accountId: PLAYWRIGHT_SCENARIOS.delete.account.id,
		message: PLAYWRIGHT_SCENARIOS.delete.message,
		label: {
			label: buildSeededReviewLabel(),
			lowConfidence: 0,
		},
	});
	await seedMessage({
		accountId: PLAYWRIGHT_SCENARIOS.finance.account.id,
		message: PLAYWRIGHT_SCENARIOS.finance.emailMessage,
		label: {
			label: buildMessageLabelV2({
				finance: {
					relevant: true,
					direction: "expense",
					owner: "business",
					accountHint: "acct:finance",
					purpose: "software_services",
				},
				commerce: {
					transactional: true,
					shopping: false,
					subscription: true,
					travel: false,
					legal: false,
				},
				routing: {
					primaryBucket: "finance",
					secondaryBuckets: ["receipt", "subscription"],
					tags: ["receipt", "software"],
				},
				explanation: "Seeded finance message for Playwright.",
			}),
			lowConfidence: 0,
		},
		financeResult: buildFinanceScenarioIntel(),
	});

	await db
		.insertInto("finance_import_runs")
		.values({
			id: "pw-finance-import-run",
			source_kind: "pdf",
			source_file_path: "/tmp/pw-finance-statement.pdf",
			source_file_sha256: "pw-finance-statement-sha",
			filename: "pw-finance-statement.pdf",
			artifact_sha256: "pw-finance-artifact-sha",
			extractor_runner: "pytest",
			extractor_model: "claude-opus",
			extractor_prompt_version: "finance-source-import.v1",
			extracted_text_hash: "pw-finance-text-sha",
			status: "imported",
			raw_artifact_json: JSON.stringify({ schemaVersion: "finance-source-import.v1" }),
			imported_at: now,
		})
		.execute();
	await db
		.insertInto("finance_import_documents")
		.values({
			id: "pw-finance-document",
			import_run_id: "pw-finance-import-run",
			source_document_ref: "statement-2026-03",
			document_type: "statement",
			issuer: "PDF Credit Union",
			external_id: "pdf-statement-2026-03",
			statement_period_start: "2026-03-01",
			statement_period_end: "2026-03-31",
			due_at: null,
			tax_year: 2026,
			owner_identity_hint: "owner:pdf",
			financial_account_hint: "acct:pdf",
			institution_hint: "inst:pdf-bank",
			evidence_text: "Imported PDF statement for March.",
			payload_json: JSON.stringify({ seeded: true }),
			created_at: now,
		})
		.execute();
	await db
		.insertInto("finance_import_transactions")
		.values({
			id: "pw-finance-transaction",
			import_run_id: "pw-finance-import-run",
			source_document_ref: "statement-2026-03",
			occurred_at: "2026-03-20",
			posted_at: "2026-03-21",
			amount_value: "51.00",
			amount_minor: 5100,
			currency: "USD",
			direction: "expense",
			description: "Imported PDF software charge",
			merchant_or_counterparty: "PDF Services",
			balance_value: null,
			owner_identity_hint: "owner:pdf",
			financial_account_hint: "acct:pdf",
			institution_hint: "inst:pdf-bank",
			category_primary: "software_services",
			category_secondary: "statement_import",
			evidence_text: "Imported PDF charge for software services.",
			payload_json: JSON.stringify({ seeded: true }),
			created_at: now,
		})
		.execute();
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
