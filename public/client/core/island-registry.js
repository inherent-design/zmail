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

function elementPath(root, element) {
	const path = [];
	let current = element;
	while (current && current !== root) {
		const parent = current.parentElement;
		if (!parent) {
			return null;
		}
		path.unshift(Array.from(parent.children).indexOf(current));
		current = parent;
	}
	return current === root ? path : null;
}

function elementAtPath(root, path) {
	let current = root;
	for (const index of path ?? []) {
		if (!current?.children || index < 0 || index >= current.children.length) {
			return null;
		}
		current = current.children[index];
	}
	return current ?? null;
}

function controlStateKey(root, control, index) {
	const stable =
		control.getAttribute("data-zmail-state-key") ||
		control.getAttribute("name") ||
		control.id;
	if (stable) {
		const value = control.getAttribute("value");
		if (control.matches("input[type='radio'], input[type='checkbox']")) {
			return `${control.tagName.toLowerCase()}:${stable}:${value ?? index}`;
		}
		return `${control.tagName.toLowerCase()}:${stable}`;
	}
	return `path:${JSON.stringify(elementPath(root, control) ?? [index])}`;
}

function selectedValues(select) {
	return Array.from(select.selectedOptions).map((option) => option.value);
}

function captureControlState(root, control, index) {
	const path = elementPath(root, control);
	const state = {
		key: controlStateKey(root, control, index),
		path,
		tag: control.tagName.toLowerCase(),
		type: control.getAttribute("type") ?? "",
	};
	if (control.tagName === "INPUT") {
		state.value = control.value;
		state.checked = control.checked;
		if (typeof control.selectionStart === "number") {
			state.selectionStart = control.selectionStart;
			state.selectionEnd = control.selectionEnd;
			state.selectionDirection = control.selectionDirection;
		}
	} else if (control.tagName === "TEXTAREA") {
		state.value = control.value;
		state.selectionStart = control.selectionStart;
		state.selectionEnd = control.selectionEnd;
		state.selectionDirection = control.selectionDirection;
	} else if (control.tagName === "SELECT") {
		state.value = control.value;
		state.selectedValues = selectedValues(control);
	}
	if (control.hasAttribute("data-zmail-preserve-pending")) {
		state.disabled = Boolean(control.disabled);
	}
	return state;
}

function controlByState(root, controlsByKey, state) {
	return (
		(state.key ? controlsByKey.get(state.key) : null) ??
		(Array.isArray(state.path) ? elementAtPath(root, state.path) : null)
	);
}

function restoreControlState(root, state) {
	if (!Array.isArray(state?.controls)) {
		return;
	}
	const controls = Array.from(root.querySelectorAll("input, textarea, select"));
	const controlsByKey = new Map(
		controls.map((control, index) => [
			controlStateKey(root, control, index),
			control,
		]),
	);
	for (const item of state.controls) {
		const control = controlByState(root, controlsByKey, item);
		if (!control) {
			continue;
		}
		if (control.tagName === "INPUT") {
			if (control.type === "checkbox" || control.type === "radio") {
				control.checked = Boolean(item.checked);
			} else if (typeof item.value === "string") {
				control.value = item.value;
			}
			restoreSelection(control, item);
		} else if (control.tagName === "TEXTAREA") {
			if (typeof item.value === "string") {
				control.value = item.value;
			}
			restoreSelection(control, item);
		} else if (control.tagName === "SELECT") {
			const selected = Array.isArray(item.selectedValues)
				? new Set(item.selectedValues.map(String))
				: new Set([String(item.value ?? "")]);
			for (const option of Array.from(control.options)) {
				option.selected = selected.has(option.value);
			}
		}
		if (
			control.hasAttribute("data-zmail-preserve-pending") &&
			typeof item.disabled === "boolean"
		) {
			control.disabled = item.disabled;
		}
	}
}

function restoreSelection(control, state) {
	if (
		typeof state.selectionStart !== "number" ||
		typeof state.selectionEnd !== "number" ||
		typeof control.setSelectionRange !== "function"
	) {
		return;
	}
	try {
		control.setSelectionRange(
			state.selectionStart,
			state.selectionEnd,
			state.selectionDirection ?? "none",
		);
	} catch {}
}

function captureScrollState(root) {
	const containers = Array.from(
		root.querySelectorAll("[data-zmail-scroll-key]"),
	);
	return containers.map((element) => ({
		key: element.getAttribute("data-zmail-scroll-key"),
		scrollTop: element.scrollTop,
		scrollLeft: element.scrollLeft,
	}));
}

function restoreScrollState(root, state) {
	if (root instanceof HTMLElement && typeof state?.scrollTop === "number") {
		root.scrollTop = state.scrollTop;
	}
	if (root instanceof HTMLElement && typeof state?.scrollLeft === "number") {
		root.scrollLeft = state.scrollLeft;
	}
	if (!Array.isArray(state?.scrollContainers)) {
		return;
	}
	const byKey = new Map(
		state.scrollContainers.map((item) => [String(item.key), item]),
	);
	for (const element of Array.from(
		root.querySelectorAll("[data-zmail-scroll-key]"),
	)) {
		const item = byKey.get(element.getAttribute("data-zmail-scroll-key") ?? "");
		if (!item) {
			continue;
		}
		if (typeof item.scrollTop === "number") {
			element.scrollTop = item.scrollTop;
		}
		if (typeof item.scrollLeft === "number") {
			element.scrollLeft = item.scrollLeft;
		}
	}
}

function captureDetailsState(root) {
	return Array.from(root.querySelectorAll("details")).map((details, index) => ({
		key: details.getAttribute("data-zmail-state-key") ?? `index:${index}`,
		open: Boolean(details.open),
	}));
}

function restoreDetailsState(root, state) {
	if (!Array.isArray(state?.details)) {
		return;
	}
	const byKey = new Map(state.details.map((item) => [String(item.key), item]));
	Array.from(root.querySelectorAll("details")).forEach((details, index) => {
		const key =
			details.getAttribute("data-zmail-state-key") ?? `index:${index}`;
		const item = byKey.get(key);
		if (item) {
			details.open = Boolean(item.open);
		}
	});
}

function captureSortState(root) {
	return Array.from(root.querySelectorAll("[data-zmail-sort-key]")).map(
		(element) => ({
			key: element.getAttribute("data-zmail-sort-key"),
			ariaSort: element.getAttribute("aria-sort"),
			direction: element.getAttribute("data-zmail-sort-direction"),
			pressed: element.getAttribute("aria-pressed"),
		}),
	);
}

function restoreSortState(root, state) {
	if (!Array.isArray(state?.sortControls)) {
		return;
	}
	const byKey = new Map(
		state.sortControls.map((item) => [String(item.key), item]),
	);
	for (const element of Array.from(
		root.querySelectorAll("[data-zmail-sort-key]"),
	)) {
		const item = byKey.get(element.getAttribute("data-zmail-sort-key") ?? "");
		if (!item) {
			continue;
		}
		setOptionalAttribute(element, "aria-sort", item.ariaSort);
		setOptionalAttribute(element, "data-zmail-sort-direction", item.direction);
		setOptionalAttribute(element, "aria-pressed", item.pressed);
	}
}

function setOptionalAttribute(element, name, value) {
	if (typeof value === "string") {
		element.setAttribute(name, value);
	} else {
		element.removeAttribute(name);
	}
}

export function captureGenericState(root) {
	const active = document.activeElement;
	const focusedPath =
		active && root.contains(active) ? elementPath(root, active) : null;
	const controls = Array.from(root.querySelectorAll("input, textarea, select"));
	return {
		scrollTop: root instanceof HTMLElement ? root.scrollTop : 0,
		scrollLeft: root instanceof HTMLElement ? root.scrollLeft : 0,
		focusedPath,
		controls: controls.map((control, index) =>
			captureControlState(root, control, index),
		),
		scrollContainers: captureScrollState(root),
		details: captureDetailsState(root),
		sortControls: captureSortState(root),
	};
}

export function restoreGenericState(root, state) {
	if (!state || typeof state !== "object") {
		return;
	}
	restoreControlState(root, state);
	restoreDetailsState(root, state);
	restoreSortState(root, state);
	restoreScrollState(root, state);
	if (Array.isArray(state.focusedPath)) {
		const focused = elementAtPath(root, state.focusedPath);
		if (focused && typeof focused.focus === "function") {
			focused.focus();
			const item = state.controls?.find(
				(control) => controlByState(root, new Map(), control) === focused,
			);
			if (item) {
				restoreSelection(focused, item);
			}
		}
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

	function islandsForEvent(event) {
		if (!currentModule?.islands) {
			return [];
		}
		return Object.entries(currentModule.islands)
			.filter(([, mod]) => mod?.shouldRefresh?.(event))
			.map(([id]) => id);
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
		islandsForEvent,
		cleanup,
		currentPage: () => currentPage,
	};
}
