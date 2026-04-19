function parsePayload(button) {
	return button.dataset.payload ? JSON.parse(button.dataset.payload) : {};
}

export function init(app) {
	const actionsRoot = document.querySelector(
		'[data-page-actions="account-detail"]',
	);
	const accountId = app.currentPathname().split("/")[2];

	const onClick = async (event) => {
		const button = event.target.closest("button[data-rpc]");
		if (!button) {
			return;
		}
		button.disabled = true;
		try {
			await app.postJson(button.dataset.rpc, parsePayload(button));
			await app.refresh();
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
			button.disabled = false;
		}
	};

	actionsRoot?.addEventListener("click", onClick);
	const refresh = () => void app.refresh();
	const unsubscribers = [
		app.subscribe("accounts", refresh),
		app.subscribe(`account:${accountId}`, refresh),
		app.subscribe("jobs", refresh),
	];

	return () => {
		actionsRoot?.removeEventListener("click", onClick);
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
