const ACCOUNT_ISLANDS = ["accounts.summary", "accounts.list"];

export function accountsIslandHints(event) {
	if (
		event.topic !== "accounts" &&
		!["job.queued", "job.claimed", "job.updated"].includes(
			String(event.eventType),
		)
	) {
		return [];
	}
	return ACCOUNT_ISLANDS;
}

export function init(app) {
	const refresh = (event) => {
		const islands = accountsIslandHints(event);
		if (islands.length === 0) {
			return;
		}
		void app.scheduleRefresh({
			islands,
			immediate: true,
			fallback: "none",
			source: "sse",
		});
	};
	const unsubscribers = [
		app.subscribe("accounts", refresh),
		app.subscribe("jobs", refresh),
	];
	return () => {
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
