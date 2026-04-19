export function init(app) {
	const root = document.querySelector('[data-page-actions="account-delete"]');
	const input = root?.querySelector("[data-confirmation-email]");
	const button = root?.querySelector("button[data-rpc]");
	const status = root?.querySelector("[data-delete-status]");

	const syncDisabledState = () => {
		if (!button || !input) {
			return;
		}
		button.disabled = input.value !== button.dataset.expectedEmail;
	};

	const onInput = () => syncDisabledState();
	const onClick = async () => {
		if (!button || !input) {
			return;
		}
		button.disabled = true;
		if (status) {
			status.textContent = "Deleting local account...";
		}
		try {
			await app.postJson(button.dataset.rpc, {
				confirmationEmail: input.value,
			});
			window.location.href = app.appPath("/accounts");
		} catch (error) {
			if (status) {
				status.textContent =
					error instanceof Error ? error.message : String(error);
			}
			syncDisabledState();
		}
	};

	input?.addEventListener("input", onInput);
	button?.addEventListener("click", onClick);
	syncDisabledState();
	return () => {
		input?.removeEventListener("input", onInput);
		button?.removeEventListener("click", onClick);
	};
}
