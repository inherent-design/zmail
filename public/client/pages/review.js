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
		event.preventDefault();
		const section = button.closest("[data-review-id]");
		const finding = button.closest("[data-review-finding-key]");
		try {
			const payload = button.dataset.payload
				? JSON.parse(button.dataset.payload)
				: {};
			if (section && payload.action === "override") {
				const text =
					section?.querySelector("[data-override-json]")?.value ?? "{}";
				try {
					payload.override = JSON.parse(text);
				} catch {
					throw new Error("Override JSON must be valid JSON.");
				}
			}
			const note = (finding ?? section)?.querySelector(
				"[data-resolution-note]",
			)?.value;
			if (note && finding) {
				payload.resolutionNote = note;
			} else if (note) {
				payload.note = note;
			}
			await app.mutate(button, {
				payload,
				fallbackTargets: [
					finding
						? {
								type: "node",
								nodeId: "review.finding.item",
								islandId: "review.queue",
								key: finding.dataset.reviewFindingKey ?? "",
							}
						: null,
					section &&
					(payload.action === "accept" || payload.action === "override")
						? {
								type: "node",
								nodeId: "review.queue.item",
								islandId: "review.queue",
								key: section?.dataset.reviewId ?? "",
							}
						: null,
					...REVIEW_ISLANDS.map((id) => ({ type: "island", id })),
				].filter(Boolean),
				fallback: "none",
			});
		} catch (error) {
			const errorNode = (finding ?? section)?.querySelector(
				"[data-mutation-error]",
			);
			if (errorNode) {
				errorNode.textContent =
					error instanceof Error ? error.message : String(error);
			}
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
