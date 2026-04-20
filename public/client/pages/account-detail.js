const SYNC_ACTION_ISLANDS = [
	"account.actions",
	"account.mailbox-sync",
	"account.lanes",
	"account.recent-jobs",
];

const LIFECYCLE_ACTION_ISLANDS = [
	"account.header",
	"account.actions",
	"account.mailbox-sync",
];

const CLASSIFIER_ACTION_ISLANDS = ["account.lanes", "account.recent-jobs"];

function parsePayload(button) {
	return button.dataset.payload ? JSON.parse(button.dataset.payload) : {};
}

function isTerminalJob(event) {
	return (
		event.eventType === "job.updated" &&
		(event.payload?.status === "complete" || event.payload?.status === "failed")
	);
}

function actionRefreshIslands(button) {
	const rpc = button.dataset.rpc ?? "";
	if (
		rpc.includes("/sync/full") ||
		rpc.includes("/sync/delta") ||
		rpc.includes("/sync/reconcile")
	) {
		return SYNC_ACTION_ISLANDS;
	}
	if (
		rpc.includes("/pause") ||
		rpc.includes("/resume") ||
		rpc.includes("/disconnect")
	) {
		return LIFECYCLE_ACTION_ISLANDS;
	}
	if (rpc.includes("/classify/")) {
		return CLASSIFIER_ACTION_ISLANDS;
	}
	return [
		"account.header",
		"account.actions",
		"account.mailbox-sync",
		"account.lanes",
		"account.recent-jobs",
	];
}

export function accountDetailIslandHints(event, accountId) {
	if (
		event.eventType === "account.sync_status" ||
		event.eventType === "account.watcher_status"
	) {
		return ["account.header", "account.actions", "account.mailbox-sync"];
	}
	if (
		!["job.queued", "job.claimed", "job.updated"].includes(
			String(event.eventType),
		) ||
		event.payload?.scopeType !== "account" ||
		event.payload?.scopeId !== accountId
	) {
		return [];
	}
	const islands = ["account.lanes", "account.recent-jobs"];
	if (event.payload?.lane === "sync") {
		islands.push("account.mailbox-sync");
	}
	return islands;
}

export function init(app) {
	const root = document.getElementById("app-main");
	if (!root || root.dataset.page !== "account-detail") {
		return null;
	}
	const accountId = app.currentPathname().split("/")[2];

	const onClick = async (event) => {
		const button = event.target.closest("button[data-rpc]");
		if (!button || !root.contains(button)) {
			return;
		}
		button.disabled = true;
		try {
			await app.postJson(button.dataset.rpc, parsePayload(button));
			await app.refresh({
				islands: actionRefreshIslands(button),
				fallback: "none",
			});
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
			button.disabled = false;
		}
	};

	root.addEventListener("click", onClick);
	const onAccountEvent = (event) => {
		const islands = accountDetailIslandHints(event, accountId);
		if (islands.length === 0) {
			return;
		}
		void app.scheduleRefresh({
			islands,
			immediate:
				isTerminalJob(event) ||
				event.eventType === "account.sync_status" ||
				event.eventType === "account.watcher_status",
			fallback: "none",
		});
	};
	const unsubscribers = [app.subscribe(`account:${accountId}`, onAccountEvent)];

	return () => {
		root.removeEventListener("click", onClick);
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
