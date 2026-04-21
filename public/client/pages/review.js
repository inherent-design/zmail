const REVIEW_ISLANDS = ["review.stats", "review.actions", "review.queue"];

export function reviewIslandHints(event) {
	if (event.topic !== "reviews") {
		return [];
	}
	return REVIEW_ISLANDS;
}

export function init(app) {
	const clickHandler = async (event) => {
		const button = event.target.closest("button[data-rpc]");
		if (!button) {
			return;
		}
		const section = button.closest("[data-review-id]");
		const errorNode = section?.querySelector("[data-review-error]");
		button.disabled = true;
		if (errorNode) {
			errorNode.textContent = "";
		}
		try {
			const payload = button.dataset.payload
				? JSON.parse(button.dataset.payload)
				: {};
			if (payload.action === "override") {
				const text =
					section?.querySelector("[data-override-json]")?.value ?? "{}";
				try {
					payload.override = JSON.parse(text);
				} catch {
					throw new Error("Override JSON must be valid JSON.");
				}
			}
			await app.postJson(button.dataset.rpc, payload);
			await app.refresh({
				islands: REVIEW_ISLANDS,
				fallback: "none",
			});
		} catch (error) {
			if (errorNode) {
				errorNode.textContent =
					error instanceof Error ? error.message : String(error);
			}
			button.disabled = false;
		}
	};

	document.addEventListener("click", clickHandler);
	const refresh = (event) => {
		const islands = reviewIslandHints(event);
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
	const unsubscribers = [app.subscribe("reviews", refresh)];
	return () => {
		document.removeEventListener("click", clickHandler);
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
