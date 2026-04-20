export const SSE_EVENTS = [
	"job.queued",
	"job.claimed",
	"job.updated",
	"account.sync_status",
	"account.watcher_status",
	"review.updated",
	"message.label_updated",
	"finance.ledger_rebuilt",
	"finance.patterns_rebuilt",
	"finance.export_started",
	"finance.export_completed",
	"finance.export_failed",
	"finance.tax_report_completed",
	"finance.registry_suggestions_created",
	"finance.migration_archived",
	"finance.reclassify_queued",
];

export function normalizeTopics(topics) {
	return [
		...new Set(
			[...topics].map((topic) => String(topic ?? "").trim()).filter(Boolean),
		),
	].sort();
}

export function buildEventsUrl({ topics, cursor, basePath = "/" }) {
	const query = new URLSearchParams();
	const normalized = normalizeTopics(topics);
	if (normalized.length > 0) {
		query.set("topics", normalized.join(","));
	}
	if (cursor != null) {
		query.set("cursor", String(cursor));
	}
	const path = basePath === "/" ? "/events" : `${basePath}/events`;
	return `${path}?${query.toString()}`;
}

export function parseEventPayload(raw) {
	return JSON.parse(raw);
}
