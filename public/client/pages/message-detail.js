const MESSAGE_ISLANDS = [
	"message.header",
	"message.body",
	"message.labels",
	"message.finance",
	"message.reviews",
	"message.actions",
];

export function messageDetailIslandHints(event) {
	if (event.topic === "reviews") {
		return ["message.labels", "message.reviews", "message.actions"];
	}
	return MESSAGE_ISLANDS;
}

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
			await app.refresh({
				islands: MESSAGE_ISLANDS,
				fallback: "none",
			});
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
			button.disabled = false;
		}
	};

	button?.addEventListener("click", onClick);
	const refresh = (event) =>
		void app.scheduleRefresh({
			islands: messageDetailIslandHints(event),
			immediate: true,
			fallback: "none",
			source: "sse",
		});
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
