import { sql } from "kysely";

import { ensureStorageDirs } from "#/lib/config";
import { getDb, runMigrations } from "#/lib/db";
import { queueJobIdempotent } from "#/lib/jobs";
import type { LogTrace } from "#/lib/log";
import { reextractStoredBadBodyMessage } from "#/lib/sync";
import { runCli } from "#/scripts/_shared";

export async function main(_trace?: LogTrace) {
	ensureStorageDirs();
	runMigrations();

	const db = getDb();
	const targets = await db
		.selectFrom("messages")
		.select(["id", "account_id"])
		.where("parse_status", "=", "parsed")
		.where((eb) =>
			eb.or([
				eb("snippet", "=", "undefined"),
				eb("body_text_primary", "in", [
					"undefined",
					"Plain text version not available",
				]),
				sql<boolean>`
					${eb.ref("body_extraction_strategy")} = 'plain_text'
					and (
						lower(${eb.ref("body_text_primary")}) like '<html%'
						or lower(${eb.ref("body_text_primary")}) like '<!doctype%'
					)
				`,
			]),
		)
		.orderBy("received_at", "asc")
		.execute();

	const recoveredAccountIds = new Set<string>();
	const summary = {
		targeted: targets.length,
		recovered: 0,
		stillFailing: 0,
		missingRaw: 0,
		queuedAccounts: 0,
	};

	for (const target of targets) {
		const result = await reextractStoredBadBodyMessage({
			messageId: target.id,
		});

		if (result.outcome === "recovered") {
			summary.recovered += 1;
			recoveredAccountIds.add(result.accountId);
		} else if (result.outcome === "stillFailing") {
			summary.stillFailing += 1;
		} else {
			summary.missingRaw += 1;
		}
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

runCli(main, import.meta.url, "reextract:bad-bodies");
