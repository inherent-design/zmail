export function init(app) {
	const root = document.querySelector('[data-page-actions="finance"]');
	const onClick = async (event) => {
		const button = event.target.closest("button[data-rpc]");
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
	root?.addEventListener("click", onClick);
	const onSubmit = async (event) => {
		const form = event.target.closest("form[data-rpc]");
		if (!form) {
			return;
		}
		event.preventDefault();
		const submit = form.querySelector('button[type="submit"]');
		if (submit) {
			submit.disabled = true;
		}
		try {
			const formData = new FormData(form);
			const payload = {};
			for (const [key, value] of formData.entries()) {
				if (value === "") {
					payload[key] = null;
				} else if (key === "year") {
					payload[key] = Number(value);
				} else if (key === "strict") {
					payload[key] = value === "on" || value === "true";
				} else {
					payload[key] = value;
				}
			}
			if (!formData.has("strict")) {
				payload.strict = false;
			}
			await app.postJson(form.dataset.rpc, payload);
			await app.refresh();
		} catch (error) {
			window.alert(error instanceof Error ? error.message : String(error));
			if (submit) {
				submit.disabled = false;
			}
		}
	};
	root?.addEventListener("submit", onSubmit);
	const isTerminalJob = (event) =>
		event.eventType === "job.updated" &&
		(event.payload?.status === "complete" ||
			event.payload?.status === "failed");
	const isFinanceJob = (event) => {
		const kind = String(event.payload?.kind ?? "");
		const scopeId = String(event.payload?.scopeId ?? "");
		return (
			kind.includes("finance") ||
			kind.includes("registry") ||
			scopeId === "finance" ||
			scopeId === "registry_suggestions"
		);
	};
	const onFinance = () => void app.scheduleRefresh({ immediate: true });
	const onJobs = (event) => {
		if (!isFinanceJob(event)) {
			return;
		}
		void app.scheduleRefresh({ immediate: isTerminalJob(event) });
	};
	const unsubscribers = [
		app.subscribe("finance", onFinance),
		app.subscribe("jobs", onJobs),
	];
	return () => {
		root?.removeEventListener("click", onClick);
		root?.removeEventListener("submit", onSubmit);
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
