import { ensureStorageDirs } from "#/lib/config";
import { getDb, runMigrations } from "#/lib/db";
import { queueJobIdempotent } from "#/lib/jobs";
import type { LogTrace } from "#/lib/log";
import { reextractStoredParseErrorMessage } from "#/lib/sync";
import { runCli } from "#/scripts/_shared";

const TARGET_PARSE_ERROR_REASON = "input.html?.trim is not a function";

async function closeOpenParseErrorReviews(input: {
	messageId: string;
	note: string;
}) {
	const db = getDb();
	const now = new Date().toISOString();
	await db
		.updateTable("reviews")
		.set({
			status: "resolved",
			resolved_at: now,
			reviewer_note: input.note,
		})
		.where("message_id", "=", input.messageId)
		.where("status", "=", "open")
		.execute();
}

export async function main(_trace?: LogTrace) {
	ensureStorageDirs();
	runMigrations();

	const db = getDb();
	const targets = await db
		.selectFrom("messages")
		.select(["id", "account_id"])
		.where("parse_status", "=", "error")
		.where("parse_error_reason", "=", TARGET_PARSE_ERROR_REASON)
		.orderBy("received_at", "asc")
		.execute();

	const recoveredAccountIds = new Set<string>();
	const summary = {
		targeted: targets.length,
		recovered: 0,
		stillFailing: 0,
		missingRaw: 0,
		closedReviews: 0,
		queuedAccounts: 0,
	};

	for (const target of targets) {
		const openReviewCount = await db
			.selectFrom("reviews")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("message_id", "=", target.id)
			.where("status", "=", "open")
			.executeTakeFirstOrThrow();

		const result = await reextractStoredParseErrorMessage({
			messageId: target.id,
		});

		if (result.outcome === "recovered") {
			summary.recovered += 1;
			recoveredAccountIds.add(result.accountId);
			await closeOpenParseErrorReviews({
				messageId: target.id,
				note: "Superseded by parse-error re-extraction.",
			});
		} else if (result.outcome === "stillFailing") {
			summary.stillFailing += 1;
			await closeOpenParseErrorReviews({
				messageId: target.id,
				note: "Closed by parse-error recovery; parser failures are audited outside review.",
			});
		} else {
			summary.missingRaw += 1;
			await closeOpenParseErrorReviews({
				messageId: target.id,
				note: "Closed by parse-error recovery; parser failures are audited outside review.",
			});
		}

		summary.closedReviews += Number(openReviewCount.count);
	}

	for (const accountId of recoveredAccountIds) {
		await queueJobIdempotent({
			kind: "classify_account_backlog",
			scopeType: "account",
			scopeId: accountId,
		});
		summary.queuedAccounts += 1;
	}

	console.log(JSON.stringify(summary, null, 2));
}

runCli(main, import.meta.url, "reextract:parse-errors");
