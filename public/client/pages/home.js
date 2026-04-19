export function init(app) {
	const refresh = () => void app.scheduleRefresh({ immediate: true });
	const onJob = (event) => {
		if (event.eventType !== "job.updated") {
			return;
		}
		const terminal =
			event.payload?.status === "complete" ||
			event.payload?.status === "failed";
		void app.scheduleRefresh({ immediate: terminal });
	};
	const unsubscribers = [
		app.subscribe("jobs", onJob),
		app.subscribe("accounts", refresh),
		app.subscribe("reviews", refresh),
	];
	return () => {
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
