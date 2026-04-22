export function init(app) {
	const root = document.querySelector('[data-page-actions="account-form"]');
	const labelInput = root?.querySelector("[data-account-label]");
	const status = root?.querySelector("[data-form-status]");
	const button = root?.querySelector("button[data-rpc]");

	const onClick = async () => {
		if (!button || !labelInput) {
			return;
		}
		const label = labelInput.value.trim();
		if (!label) {
			status.textContent = "Account label is required.";
			return;
		}
		button.disabled = true;
		status.textContent = "Redirecting...";
		try {
			await app.mutate(button, {
				payload: { label },
				fallbackTargets: [{ type: "main" }],
			});
		} catch (error) {
			status.textContent =
				error instanceof Error ? error.message : String(error);
			button.disabled = false;
		}
	};

	button?.addEventListener("click", onClick);
	return () => button?.removeEventListener("click", onClick);
}
