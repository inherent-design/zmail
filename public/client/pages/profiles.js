const PROFILE_ISLANDS = [
	"profiles.header",
	"profiles.summary",
	"profiles.findings",
	"profiles.actions",
];

export function profileIslandHints(event, accountId) {
	if (event.topic === `account:${accountId}`) {
		return PROFILE_ISLANDS;
	}
	if (
		event.payload?.accountId === accountId ||
		event.entityKind === "finance_profile" ||
		event.eventType === "finance.ledger_rebuilt" ||
		event.eventType === "finance.patterns_rebuilt"
	) {
		return ["profiles.summary", "profiles.findings"];
	}
	if (
		event.eventType === "job.updated" &&
		(event.payload?.status === "complete" ||
			event.payload?.status === "failed") &&
		event.payload?.scopeId === accountId
	) {
		return PROFILE_ISLANDS;
	}
	return [];
}

export function init(app) {
	const root = document.querySelector('[data-page-actions="profiles"]');
	const button = root?.querySelector("button[data-rpc]");
	const accountId = app.currentPathname().split("/")[2];
	const onClick = async () => {
		if (!button) {
			return;
		}
		button.disabled = true;
		try {
			await app.postJson(button.dataset.rpc, {});
			await app.refresh({
				islands: PROFILE_ISLANDS,
				fallback: "none",
			});
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
			button.disabled = false;
		}
	};
	button?.addEventListener("click", onClick);
	const refresh = (event) => {
		const islands = profileIslandHints(event, accountId);
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
		app.subscribe(`account:${accountId}`, refresh),
		app.subscribe("finance", refresh),
		app.subscribe("jobs", refresh),
	];
	return () => {
		button?.removeEventListener("click", onClick);
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
