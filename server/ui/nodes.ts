export type UiNodeRenderMap = Record<
	string,
	{ islandId: string; render: (key: string) => unknown | null }
>;

export const UI_NODE_DEFINITIONS = {
	"account.list.item": { parentIslandId: "accounts.list", key: "accountId" },
	"account.detail.job": {
		parentIslandId: "account.recent-jobs",
		key: "jobId",
	},
	"message.list.row": { parentIslandId: "messages.list", key: "messageId" },
	"message.review.item": { parentIslandId: "message.reviews", key: "reviewId" },
	"review.queue.item": { parentIslandId: "review.queue", key: "reviewId" },
	"review.finding.item": {
		parentIslandId: "review.queue",
		key: "targetKind:targetId",
	},
	"finance.ledger.row": {
		parentIslandId: "finance.ledger",
		key: "canonicalKey",
	},
	"finance.review.ledger-row": {
		parentIslandId: "finance.review",
		key: "canonicalKey",
	},
	"finance.mapping.candidate": {
		parentIslandId: "finance.mappings",
		key: "suggestionId",
	},
	"finance.review.finding": {
		parentIslandId: "finance.review",
		key: "targetKind:targetId",
	},
	"finance.upload.run": { parentIslandId: "finance.imports", key: "uploadId" },
	"finance.import.run": {
		parentIslandId: "finance.imports",
		key: "importRunId",
	},
	"finance.export.run": {
		parentIslandId: "finance.export-health",
		key: "exportRunId",
	},
	"finance.tax.run": { parentIslandId: "finance.tax", key: "taxReportRunId" },
	"profile.finding.item": {
		parentIslandId: "profiles.findings",
		key: "findingId",
	},
	"runs.job.row": { parentIslandId: "runs.jobs", key: "jobId" },
	"ops.health.failed-job": { parentIslandId: "ops.health", key: "jobId" },
} as const;

export type UiNodeId = keyof typeof UI_NODE_DEFINITIONS;

export function uiNodeParentIsland(nodeId: string) {
	return UI_NODE_DEFINITIONS[nodeId as UiNodeId]?.parentIslandId ?? null;
}
