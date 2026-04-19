export function createIslandRegistry(loaders) {
	let currentPage = null;
	let currentCleanup = null;

	async function mount(page, app) {
		currentPage = page;
		if (typeof currentCleanup === "function") {
			currentCleanup();
			currentCleanup = null;
		}
		const loader = loaders[page];
		if (!loader) {
			return;
		}
		const mod = await loader();
		currentCleanup = mod.init?.(app) ?? null;
	}

	function cleanup() {
		if (typeof currentCleanup === "function") {
			currentCleanup();
			currentCleanup = null;
		}
	}

	return {
		mount,
		cleanup,
		currentPage: () => currentPage,
	};
}
