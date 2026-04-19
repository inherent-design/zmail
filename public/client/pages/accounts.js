export function init(app) {
	const refresh = () => void app.refresh();
	const unsubscribers = [app.subscribe("accounts", refresh)];
	return () => {
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
	};
}
