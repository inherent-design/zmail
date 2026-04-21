function isTerminalJob(event) {
	return (
		event.eventType === "job.updated" &&
		(event.payload?.status === "complete" || event.payload?.status === "failed")
	);
}

export function init(app) {
	const refresh = (event) => {
		if (
			!["job.queued", "job.claimed", "job.updated"].includes(event.eventType)
		) {
			return;
		}
		const islands = ["runs.lanes"];
		if (isTerminalJob(event)) {
			islands.push("runs.jobs");
		}
		void app.scheduleRefresh({
			islands,
			immediate: isTerminalJob(event),
			fallback: "none",
			source: "sse",
		});
	};
	const unsubscribers = [app.subscribe("jobs", refresh)];
	return () => {
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
