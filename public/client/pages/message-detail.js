export function init(app) {
	const root = document.querySelector('[data-page-actions="message-detail"]');
	const button = root?.querySelector("button[data-rpc]");
	const messageId = app.currentPathname().split("/")[2];

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
	const refresh = () => void app.refresh();
	const unsubscribers = [
		app.subscribe(`message:${messageId}`, refresh),
		app.subscribe("reviews", refresh),
	];
	return () => {
		button?.removeEventListener("click", onClick);
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
