export function init(app) {
	const refresh = (event) => {
		const terminal =
			event.eventType === "job.updated" &&
			(event.payload?.status === "complete" ||
				event.payload?.status === "failed");
		void app.scheduleRefresh({ immediate: terminal });
	};
	const unsubscribers = [app.subscribe("jobs", refresh)];
	return () => {
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
