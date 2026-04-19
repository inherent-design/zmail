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
			await app.refresh();
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
			button.disabled = false;
		}
	};
	button?.addEventListener("click", onClick);
	const refresh = () => void app.scheduleRefresh({ immediate: true });
	const onFinance = (event) => {
		if (
			event.payload?.accountId === accountId ||
			event.entityKind === "finance_profile" ||
			event.eventType === "finance.ledger_rebuilt" ||
			event.eventType === "finance.patterns_rebuilt"
		) {
			refresh();
		}
	};
	const onJobs = (event) => {
		if (
			event.eventType === "job.updated" &&
			(event.payload?.status === "complete" ||
				event.payload?.status === "failed") &&
			event.payload?.scopeId === accountId
		) {
			refresh();
		}
	};
	const unsubscribers = [
		app.subscribe(`account:${accountId}`, refresh),
		app.subscribe("finance", onFinance),
		app.subscribe("jobs", onJobs),
	];
	return () => {
		button?.removeEventListener("click", onClick);
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
