const HOME_STATS = ["home.stats"];
const HOME_JOB_ISLANDS = ["home.stats", "home.lanes"];

function isTerminalJob(event) {
	return (
		event.eventType === "job.updated" &&
		(event.payload?.status === "complete" || event.payload?.status === "failed")
	);
}

export function init(app) {
	const refreshStats = () =>
		void app.scheduleRefresh({
			islands: HOME_STATS,
			immediate: true,
			fallback: "none",
			source: "sse",
		});
	const onJob = (event) => {
		if (
			!["job.queued", "job.claimed", "job.updated"].includes(event.eventType)
		) {
			return;
		}
		void app.scheduleRefresh({
			islands: HOME_JOB_ISLANDS,
			immediate: isTerminalJob(event),
			fallback: "none",
			source: "sse",
		});
	};
	const unsubscribers = [
		app.subscribe("jobs", onJob),
		app.subscribe("accounts", refreshStats),
		app.subscribe("reviews", refreshStats),
	];
	return () => {
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
