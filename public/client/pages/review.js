export function init(app) {
	const clickHandler = async (event) => {
		const button = event.target.closest("button[data-rpc]");
		if (!button) {
			return;
		}
		const section = button.closest("[data-review-id]");
		const reviewId = section?.dataset.reviewId;
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
			if (reviewId) {
				section?.remove();
			} else {
				await app.refresh();
			}
		} catch (error) {
			if (errorNode) {
				errorNode.textContent =
					error instanceof Error ? error.message : String(error);
			}
			button.disabled = false;
		}
	};

	document.addEventListener("click", clickHandler);
	const refresh = () => void app.refresh();
	const unsubscribers = [app.subscribe("reviews", refresh)];
	return () => {
		document.removeEventListener("click", clickHandler);
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
