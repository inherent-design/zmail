function readStateScope() {
	return document.documentElement.dataset.zmailStateScope || "local";
}

function readProps(id) {
	const script = document.querySelector(
		`script[type="application/json"][data-zmail-island-props="${id}"]`,
	);
	if (!script?.textContent) {
		return null;
	}
	try {
		return JSON.parse(script.textContent);
	} catch {
		return null;
	}
}

function stateKey(page, id) {
	return `zmail:island:${readStateScope()}:${page}:${id}`;
}

function readStoredState(page, id) {
	try {
		return JSON.parse(sessionStorage.getItem(stateKey(page, id)) ?? "null");
	} catch {
		return null;
	}
}

function writeStoredState(page, id, state) {
	try {
		sessionStorage.setItem(stateKey(page, id), JSON.stringify(state));
	} catch {}
}

function captureGenericState(root) {
	return {
		scrollTop: root instanceof HTMLElement ? root.scrollTop : 0,
		detailsOpen: Array.from(root.querySelectorAll("details")).map((details) =>
			Boolean(details.open),
		),
	};
}

function restoreGenericState(root, state) {
	if (!state || typeof state !== "object") {
		return;
	}
	if (root instanceof HTMLElement && typeof state.scrollTop === "number") {
		root.scrollTop = state.scrollTop;
	}
	if (Array.isArray(state.detailsOpen)) {
		const details = Array.from(root.querySelectorAll("details"));
		details.forEach((item, index) => {
			item.open = Boolean(state.detailsOpen[index]);
		});
	}
}

export function createIslandRegistry(loaders) {
	let currentPage = null;
	let currentModule = null;
	let currentCleanup = null;
	const islandCleanups = new Map();

	async function loadPageModule(page) {
		const loader = loaders[page];
		if (!loader) {
			return null;
		}
		return loader();
	}

	function islandModule(id) {
		return currentModule?.islands?.[id] ?? null;
	}

	function cleanupIsland(id) {
		const cleanup = islandCleanups.get(id);
		if (typeof cleanup === "function") {
			cleanup();
		}
		islandCleanups.delete(id);
	}

	function cleanupIslands() {
		for (const id of Array.from(islandCleanups.keys())) {
			cleanupIsland(id);
		}
	}

	function beforeIslandSwap(id, root) {
		const state = {
			generic: captureGenericState(root),
			module: islandModule(id)?.beforeSwap?.(),
		};
		if (currentPage) {
			writeStoredState(currentPage, id, state);
		}
		cleanupIsland(id);
		return state;
	}

	async function mountIsland(id, app, state = null) {
		const root = document.querySelector(`[data-zmail-island="${id}"]`);
		if (!root) {
			cleanupIsland(id);
			return;
		}
		const stored =
			state ?? (currentPage ? readStoredState(currentPage, id) : null);
		restoreGenericState(root, stored?.generic);
		const mod = islandModule(id);
		const cleanup =
			(await mod?.init?.({
				app,
				id,
				root,
				props: readProps(id),
				state: stored?.module ?? null,
			})) ?? null;
		if (typeof cleanup === "function") {
			islandCleanups.set(id, cleanup);
		}
		await mod?.afterSwap?.(stored?.module ?? null);
	}

	async function mountAllIslands(app) {
		const roots = Array.from(document.querySelectorAll("[data-zmail-island]"));
		for (const root of roots) {
			const id = root.getAttribute("data-zmail-island");
			if (id) {
				await mountIsland(id, app);
			}
		}
	}

	async function mount(page, app) {
		currentPage = page;
		if (typeof currentCleanup === "function") {
			currentCleanup();
			currentCleanup = null;
		}
		cleanupIslands();
		currentModule = await loadPageModule(page);
		if (!currentModule) {
			return;
		}
		currentCleanup = currentModule.init?.(app) ?? null;
		await mountAllIslands(app);
	}

	async function afterIslandSwap(id, root, state, app) {
		if (!root) {
			return;
		}
		await mountIsland(id, app, state);
	}

	function cleanup() {
		if (typeof currentCleanup === "function") {
			currentCleanup();
			currentCleanup = null;
		}
		cleanupIslands();
	}

	return {
		mount,
		beforeIslandSwap,
		afterIslandSwap,
		cleanup,
		currentPage: () => currentPage,
	};
}
