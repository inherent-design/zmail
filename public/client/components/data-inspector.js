function copyText(value) {
	if (!navigator.clipboard?.writeText) {
		return Promise.reject(new Error("Clipboard API is unavailable."));
	}
	return navigator.clipboard.writeText(value);
}

export function initDataInspectors(root = document) {
	const onClick = async (event) => {
		const target = event.target?.nodeType === 1 ? event.target : null;
		const button = target?.closest("[data-copy-json],[data-copy-path]");
		if (!button || !root.contains(button)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const inspector = button.closest(".data-inspector");
		const status = inspector?.querySelector("[data-copy-status]");
		const pre = inspector?.querySelector(
			".data-inspector-raw [data-json-path]",
		);
		const value = button.hasAttribute("data-copy-path")
			? (button.dataset.copyPath ??
				button.closest("[data-json-path]")?.dataset.jsonPath ??
				"$")
			: (pre?.textContent ?? "");
		try {
			await copyText(value);
			if (status) {
				status.textContent = "Copied.";
			}
		} catch (error) {
			if (status) {
				status.textContent =
					error instanceof Error ? error.message : String(error);
			}
		}
	};
	root.addEventListener("click", onClick);
	return () => root.removeEventListener("click", onClick);
}
