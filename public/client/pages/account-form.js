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
			const payload = button.dataset.accountId ? { label } : { label };
			const result = await app.postJson(button.dataset.rpc, payload);
			if (result.url) {
				window.location.href = result.url;
				return;
			}
			await app.refresh();
		} catch (error) {
			status.textContent =
				error instanceof Error ? error.message : String(error);
			button.disabled = false;
		}
	};

	button?.addEventListener("click", onClick);
	return () => button?.removeEventListener("click", onClick);
}
