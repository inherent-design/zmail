const MAIN_PARTIAL_HEADERS = {
	"X-Zmail-Partial": "main",
};

const ISLAND_PARTIAL_HEADERS = {
	"X-Zmail-Partial": "islands",
};

const NODE_PARTIAL_HEADERS = {
	"X-Zmail-Partial": "nodes",
};

export function extractPartialMain(html, parser = new DOMParser()) {
	const doc = parser.parseFromString(html, "text/html");
	return doc.getElementById("app-main");
}

export function extractIslandFragments(html, parser = new DOMParser()) {
	const doc = parser.parseFromString(html, "text/html");
	const envelope = doc.querySelector("[data-zmail-island-fragments]");
	const roots = new Map();
	for (const root of doc.querySelectorAll("[data-zmail-island]")) {
		const id = root.getAttribute("data-zmail-island");
		if (id) {
			roots.set(id, root);
		}
	}
	return { envelope, roots };
}

export function extractNodeFragments(html, parser = new DOMParser()) {
	const doc = parser.parseFromString(html, "text/html");
	const envelope = doc.querySelector("[data-zmail-node-fragments]");
	const roots = new Map();
	for (const template of doc.querySelectorAll("[data-zmail-node-fragment]")) {
		const token = template.getAttribute("data-zmail-node-fragment");
		if (!token) {
			continue;
		}
		const content =
			"content" in template
				? template.content.firstElementChild
				: template.firstElementChild;
		if (content) {
			roots.set(token, content);
		}
	}
	return { envelope, roots };
}

function splitHeaderList(value) {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeNodeTargets(value) {
	if (!value) {
		return [];
	}
	const targets = Array.isArray(value) ? value : [value];
	const seen = new Set();
	const normalized = [];
	for (const target of targets) {
		if (!target || target.type !== "node") {
			continue;
		}
		const node = {
			type: "node",
			islandId: String(target.islandId ?? "").trim(),
			nodeId: String(target.nodeId ?? "").trim(),
			key: String(target.key ?? "").trim(),
		};
		if (!node.islandId || !node.nodeId || !node.key) {
			continue;
		}
		const dedupeKey = `${node.islandId}:${node.nodeId}:${node.key}`;
		if (seen.has(dedupeKey)) {
			continue;
		}
		seen.add(dedupeKey);
		normalized.push(node);
	}
	return normalized;
}

function normalizeIslandIds(value) {
	if (!value) {
		return null;
	}
	const ids = Array.isArray(value) ? value : [value];
	const normalized = ids.map((id) => String(id).trim()).filter(Boolean);
	return normalized.length ? Array.from(new Set(normalized)) : null;
}

function islandSelector(id) {
	return `[data-zmail-island="${String(id).replaceAll('"', '\\"')}"]`;
}

function cssEscape(value) {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
		return CSS.escape(String(value));
	}
	return String(value).replace(/["\\]/g, "\\$&");
}

function nodeToken(target) {
	return `${encodeURIComponent(target.nodeId)}:${encodeURIComponent(target.key)}`;
}

function nodeSelector(target) {
	return `[data-zmail-node="${cssEscape(target.nodeId)}"][data-zmail-node-key="${cssEscape(target.key)}"]`;
}

function eventElement(event) {
	return event.target?.nodeType === 1 ? event.target : null;
}

export function createShellNav(input = {}) {
	const {
		documentRef = document,
		windowRef = window,
		fetchImpl = fetch,
		onAfterSwap,
		onBeforeIslandSwap,
		onAfterIslandSwap,
		onBeforeNodeSwap,
		onAfterNodeSwap,
	} = input;
	let refreshInFlight = null;
	let refreshQueued = null;
	let scheduledRefreshTimer = null;
	let scheduledRefreshMaxTimer = null;
	let scheduledRefreshRequest = null;
	const deferredRefreshes = new Map();
	let deferredCleanup = null;
	let selectionDeferredCleanup = null;
	let navigationSerial = 0;
	let activeNavigation = null;

	function currentMain() {
		return documentRef.getElementById("app-main");
	}

	function currentPage() {
		return (
			currentMain()?.dataset.page ||
			documentRef.documentElement.dataset.page ||
			"unknown"
		);
	}

	function currentUrl() {
		return `${windowRef.location.pathname}${windowRef.location.search}`;
	}

	function normalizeUrl(value) {
		if (!value) {
			return null;
		}
		try {
			const url = new URL(String(value), windowRef.location.origin);
			return `${url.pathname}${url.search}`;
		} catch {
			return String(value);
		}
	}

	function isDevelopment() {
		const host = windowRef.location.hostname;
		return (
			documentRef.documentElement.dataset.zmailDebugRefresh === "1" ||
			(Boolean(windowRef.location.port) &&
				(host === "localhost" || host === "127.0.0.1" || host === "::1"))
		);
	}

	function debugRefresh(reason, detail = {}) {
		if (!isDevelopment()) {
			return;
		}
		windowRef.console?.debug?.("[zmail:refresh]", {
			reason,
			...detail,
		});
	}

	function refreshFallback(source, islands, fallback) {
		if (source === "sse") {
			return "none";
		}
		return fallback ?? (islands?.length ? "none" : "main");
	}

	function buildRefreshRequest(options = {}) {
		const islands = normalizeIslandIds(options.islands);
		const coveredIslandIds = islands ? new Set(islands) : null;
		const nodes = normalizeNodeTargets(options.nodes).filter(
			(target) => !coveredIslandIds?.has(target.islandId),
		);
		const source = options.source ?? "action";
		return {
			islands,
			nodes,
			source,
			originPage: options.originPage ?? null,
			originUrl: normalizeUrl(options.originUrl) ?? null,
			fallback: refreshFallback(source, islands, options.fallback),
		};
	}

	function sameRefreshOrigin(request) {
		if (request.originPage && request.originPage !== currentPage()) {
			debugRefresh("route-origin-mismatch-drop", {
				originPage: request.originPage,
				currentPage: currentPage(),
				islands: request.islands,
				nodes: request.nodes,
				source: request.source,
			});
			return false;
		}
		if (request.originUrl && request.originUrl !== currentUrl()) {
			debugRefresh("route-origin-mismatch-drop", {
				originUrl: request.originUrl,
				currentUrl: currentUrl(),
				islands: request.islands,
				nodes: request.nodes,
				source: request.source,
			});
			return false;
		}
		return true;
	}

	function mergeRefreshRequest(current, next) {
		if (!current) {
			return next;
		}
		const nodes = [...(current.nodes ?? []), ...(next.nodes ?? [])];
		const currentWantsMain = !current.islands?.length && !current.nodes?.length;
		const nextWantsMain = !next.islands?.length && !next.nodes?.length;
		if (currentWantsMain || nextWantsMain) {
			const source = next.source ?? current.source ?? "action";
			return {
				...next,
				source,
				islands: null,
				nodes: [],
				fallback: refreshFallback(source, null, next.fallback),
			};
		}
		const source = next.source ?? current.source ?? "action";
		const islands =
			current.islands || next.islands
				? Array.from(
						new Set([...(current.islands ?? []), ...(next.islands ?? [])]),
					)
				: null;
		const coveredIslandIds = new Set(islands ?? []);
		const mergedNodes = normalizeNodeTargets(nodes).filter(
			(target) => !coveredIslandIds.has(target.islandId),
		);
		return {
			...next,
			source,
			islands,
			nodes: mergedNodes,
			fallback: refreshFallback(
				source,
				islands,
				current.fallback === "main" || next.fallback === "main"
					? "main"
					: "none",
			),
		};
	}

	function clearDeferredRefreshes() {
		deferredCleanup?.();
		deferredCleanup = null;
		selectionDeferredCleanup?.();
		selectionDeferredCleanup = null;
		deferredRefreshes.clear();
	}

	function beginNavigation(source) {
		if (
			source === "refresh" &&
			activeNavigation &&
			activeNavigation.source !== "refresh"
		) {
			return null;
		}

		navigationSerial += 1;

		if (source === "user" || source === "popstate") {
			clearScheduledRefresh();
			clearDeferredRefreshes();
			refreshQueued = null;
		}

		activeNavigation?.controller.abort();

		const navigation = {
			serial: navigationSerial,
			controller: new AbortController(),
			source,
		};
		activeNavigation = navigation;
		return navigation;
	}

	function isCurrentNavigation(navigation) {
		return activeNavigation?.serial === navigation.serial;
	}

	function isAbortError(error) {
		return (
			(typeof DOMException !== "undefined" &&
				error instanceof DOMException &&
				error.name === "AbortError") ||
			(error instanceof Error && error.name === "AbortError")
		);
	}

	function setCursorFrom(response, fragment) {
		const eventCursor =
			response.headers.get("X-Zmail-Event-Cursor") ||
			fragment?.dataset.eventCursor;
		if (eventCursor) {
			documentRef.documentElement.dataset.zmailEventCursor = eventCursor;
		}
	}

	async function navigate(url, options = {}) {
		const nextUrl = typeof url === "string" ? url : url.toString();
		const navigation = beginNavigation(options.source ?? "action");
		if (!navigation) {
			return;
		}

		try {
			const response = await fetchImpl(nextUrl, {
				headers: {
					...MAIN_PARTIAL_HEADERS,
					"X-Requested-With": "zmail-nav",
				},
				signal: navigation.controller.signal,
			});
			if (!isCurrentNavigation(navigation)) {
				return;
			}
			if (!response.ok) {
				windowRef.location.assign(nextUrl);
				return;
			}
			const html = await response.text();
			if (!isCurrentNavigation(navigation)) {
				return;
			}
			const incomingMain = extractPartialMain(html);
			const current = currentMain();
			if (!incomingMain || !current) {
				if (isCurrentNavigation(navigation)) {
					windowRef.location.assign(nextUrl);
				}
				return;
			}
			if (!isCurrentNavigation(navigation)) {
				return;
			}
			if (documentRef.startViewTransition) {
				await documentRef.startViewTransition(() => {
					if (!isCurrentNavigation(navigation)) {
						return;
					}
					current.replaceWith(incomingMain);
				}).finished;
			} else {
				current.replaceWith(incomingMain);
			}
			if (!isCurrentNavigation(navigation)) {
				return;
			}
			setCursorFrom(response, incomingMain);
			documentRef.title =
				response.headers.get("X-Zmail-Title") || documentRef.title;
			const page =
				response.headers.get("X-Zmail-Page") ||
				incomingMain.dataset.page ||
				"unknown";
			const historyMethod = options.replace ? "replaceState" : "pushState";
			if (options.history !== false) {
				windowRef.history[historyMethod]({}, "", nextUrl);
			}
			await onAfterSwap?.(page, nextUrl);
		} catch (error) {
			if (isAbortError(error)) {
				return;
			}
			throw error;
		} finally {
			if (isCurrentNavigation(navigation)) {
				activeNavigation = null;
			}
		}
	}

	async function fallbackMainRefresh(request) {
		if (request.source === "sse") {
			debugRefresh("main-fallback-blocked", {
				source: request.source,
				islands: request.islands,
			});
			return;
		}
		if (!sameRefreshOrigin(request)) {
			return;
		}
		await navigate(currentUrl(), {
			replace: true,
			source: "refresh",
		});
	}

	async function refreshIslandsNow(request) {
		if (!request.islands?.length || !sameRefreshOrigin(request)) {
			return;
		}
		debugRefresh("island-refresh-requested", {
			islands: request.islands,
			source: request.source,
			fallback: request.fallback,
		});
		const navigation = beginNavigation("refresh");
		if (!navigation) {
			return;
		}
		const targetUrl = request.originUrl ?? currentUrl();
		try {
			const response = await fetchImpl(targetUrl, {
				headers: {
					...ISLAND_PARTIAL_HEADERS,
					"X-Zmail-Islands": request.islands.join(","),
					"X-Requested-With": "zmail-nav",
				},
				signal: navigation.controller.signal,
			});
			if (!isCurrentNavigation(navigation)) {
				return;
			}
			if (!response.ok) {
				if (request.fallback === "main") {
					await fallbackMainRefresh(request);
				}
				return;
			}
			const html = await response.text();
			if (!isCurrentNavigation(navigation) || !sameRefreshOrigin(request)) {
				return;
			}
			const { envelope, roots } = extractIslandFragments(html);
			const returnedPage = response.headers.get("X-Zmail-Page");
			if (returnedPage && returnedPage !== currentPage()) {
				return;
			}
			const supportedIds = splitHeaderList(
				response.headers.get("X-Zmail-Islands"),
			);
			const missingIds = splitHeaderList(
				response.headers.get("X-Zmail-Island-Missing"),
			);
			if (missingIds.length > 0) {
				debugRefresh("missing-islands-skipped", {
					missingIslands: missingIds,
					requestedIslands: request.islands,
					source: request.source,
				});
			}
			if (!envelope) {
				if (request.fallback === "main") {
					await fallbackMainRefresh(request);
				}
				return;
			}
			const replaceIds = request.islands.filter(
				(id) =>
					roots.has(id) &&
					supportedIds.includes(id) &&
					!missingIds.includes(id),
			);
			const replacements = [];
			for (const id of replaceIds) {
				const currentRoot = documentRef.querySelector(islandSelector(id));
				const incomingRoot = roots.get(id);
				if (!currentRoot || !incomingRoot) {
					continue;
				}
				replacements.push({
					id,
					currentRoot,
					incomingRoot,
					state: onBeforeIslandSwap?.(id, currentRoot),
				});
			}
			if (replacements.length === 0) {
				if (request.fallback === "main" && replaceIds.length === 0) {
					await fallbackMainRefresh(request);
					return;
				}
				setCursorFrom(response, envelope);
				return;
			}
			const swap = () => {
				if (!isCurrentNavigation(navigation)) {
					return;
				}
				for (const item of replacements) {
					item.currentRoot.replaceWith(item.incomingRoot);
				}
			};
			if (documentRef.startViewTransition) {
				await documentRef.startViewTransition(swap).finished;
			} else {
				swap();
			}
			if (!isCurrentNavigation(navigation) || !sameRefreshOrigin(request)) {
				return;
			}
			setCursorFrom(response, envelope);
			for (const item of replacements) {
				await onAfterIslandSwap?.(item.id, item.incomingRoot, item.state);
			}
		} catch (error) {
			if (isAbortError(error)) {
				return;
			}
			throw error;
		} finally {
			if (isCurrentNavigation(navigation)) {
				activeNavigation = null;
			}
		}
	}

	async function fallbackMissingActionNodes(request, missingTargets) {
		if (request.source === "sse" || missingTargets.length === 0) {
			return;
		}
		const islands = Array.from(
			new Set(missingTargets.map((target) => target.islandId).filter(Boolean)),
		);
		if (islands.length === 0) {
			return;
		}
		await refreshIslandsNow({
			...request,
			islands,
			nodes: [],
			fallback: "none",
		});
	}

	async function refreshNodesNow(request) {
		if (!request.nodes?.length || !sameRefreshOrigin(request)) {
			return;
		}
		debugRefresh("node-refresh-requested", {
			nodes: request.nodes.map(nodeToken),
			source: request.source,
		});
		const navigation = beginNavigation("refresh");
		if (!navigation) {
			return;
		}
		const targetUrl = request.originUrl ?? currentUrl();
		try {
			const response = await fetchImpl(targetUrl, {
				headers: {
					...NODE_PARTIAL_HEADERS,
					"X-Zmail-Nodes": request.nodes.map(nodeToken).join(","),
					"X-Requested-With": "zmail-nav",
				},
				signal: navigation.controller.signal,
			});
			if (!isCurrentNavigation(navigation)) {
				return;
			}
			if (!response.ok) {
				await fallbackMissingActionNodes(request, request.nodes);
				return;
			}
			const html = await response.text();
			if (!isCurrentNavigation(navigation) || !sameRefreshOrigin(request)) {
				return;
			}
			const { envelope, roots } = extractNodeFragments(html);
			const returnedPage = response.headers.get("X-Zmail-Page");
			if (returnedPage && returnedPage !== currentPage()) {
				return;
			}
			if (!envelope) {
				await fallbackMissingActionNodes(request, request.nodes);
				return;
			}
			const supportedTokens = new Set(
				splitHeaderList(response.headers.get("X-Zmail-Nodes")),
			);
			const missingTokens = new Set(
				splitHeaderList(response.headers.get("X-Zmail-Node-Missing")),
			);
			const replacements = [];
			const missingTargets = [];
			for (const target of request.nodes) {
				const token = nodeToken(target);
				const incomingRoot = roots.get(token);
				const currentRoot = documentRef.querySelector(nodeSelector(target));
				if (
					!incomingRoot ||
					!currentRoot ||
					missingTokens.has(token) ||
					!supportedTokens.has(token)
				) {
					missingTargets.push(target);
					continue;
				}
				replacements.push({
					target,
					currentRoot,
					incomingRoot,
					state: onBeforeNodeSwap?.(target, currentRoot),
				});
			}
			const swap = () => {
				if (!isCurrentNavigation(navigation)) {
					return;
				}
				for (const item of replacements) {
					item.currentRoot.replaceWith(item.incomingRoot);
				}
			};
			if (documentRef.startViewTransition) {
				await documentRef.startViewTransition(swap).finished;
			} else {
				swap();
			}
			if (!isCurrentNavigation(navigation) || !sameRefreshOrigin(request)) {
				return;
			}
			setCursorFrom(response, envelope);
			for (const item of replacements) {
				await onAfterNodeSwap?.(item.target, item.incomingRoot, item.state);
			}
			await fallbackMissingActionNodes(request, missingTargets);
		} catch (error) {
			if (isAbortError(error)) {
				return;
			}
			throw error;
		} finally {
			if (isCurrentNavigation(navigation)) {
				activeNavigation = null;
			}
		}
	}

	async function performRefresh(request) {
		if (!sameRefreshOrigin(request)) {
			return;
		}
		if (request.islands?.length) {
			await refreshIslandsNow(request);
		}
		if (request.nodes?.length) {
			await refreshNodesNow(request);
			return;
		}
		if (request.islands?.length || request.source === "sse") {
			debugRefresh("main-fallback-blocked", {
				source: request.source,
				islands: request.islands,
				nodes: request.nodes,
			});
			return;
		}
		await navigate(currentUrl(), {
			replace: true,
			source: "refresh",
		});
	}

	async function refresh(options = {}) {
		clearScheduledRefresh();
		refreshQueued = mergeRefreshRequest(
			refreshQueued,
			buildRefreshRequest(options),
		);
		if (!refreshInFlight) {
			refreshInFlight = (async () => {
				try {
					while (refreshQueued) {
						const request = refreshQueued;
						refreshQueued = null;
						await performRefresh(request);
					}
				} finally {
					refreshInFlight = null;
				}
			})();
		}
		return refreshInFlight;
	}

	function refreshIsland(ids, options = {}) {
		return refresh({ ...options, islands: normalizeIslandIds(ids) });
	}

	function refreshNodes(nodes, options = {}) {
		return refresh({ ...options, nodes: normalizeNodeTargets(nodes) });
	}

	function clearScheduledRefresh() {
		if (scheduledRefreshTimer) {
			clearTimeout(scheduledRefreshTimer);
			scheduledRefreshTimer = null;
		}
		if (scheduledRefreshMaxTimer) {
			clearTimeout(scheduledRefreshMaxTimer);
			scheduledRefreshMaxTimer = null;
		}
		scheduledRefreshRequest = null;
	}

	function takeScheduledRefreshRequest(fallback) {
		const request = scheduledRefreshRequest ?? fallback;
		scheduledRefreshRequest = null;
		return request;
	}

	function activeEditElement() {
		const active = documentRef.activeElement;
		if (!active || active === documentRef.body) {
			return null;
		}
		if (
			active.matches?.("input, textarea, select, [contenteditable='true']") ||
			active.closest?.("form")
		) {
			return active;
		}
		return null;
	}

	function activeIslandId(active) {
		return (
			active?.closest?.("[data-zmail-island]")?.dataset.zmailIsland ?? null
		);
	}

	function activeNodeToken(active) {
		const node = active?.closest?.("[data-zmail-node][data-zmail-node-key]");
		if (!node) {
			return null;
		}
		return nodeToken({
			nodeId: node.dataset.zmailNode,
			key: node.dataset.zmailNodeKey,
		});
	}

	function islandIdForNode(node) {
		if (!node) {
			return null;
		}
		const element =
			node.nodeType === 1 ? node : (node.parentElement ?? node.parentNode);
		return (
			element?.closest?.("[data-zmail-island]")?.dataset.zmailIsland ?? null
		);
	}

	function selectedIslandIds() {
		const selection =
			documentRef.getSelection?.() ?? windowRef.getSelection?.() ?? null;
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			return [];
		}
		return Array.from(
			new Set(
				[
					islandIdForNode(selection.anchorNode),
					islandIdForNode(selection.focusNode),
				].filter(Boolean),
			),
		);
	}

	function selectedNodeTokens() {
		const selection =
			documentRef.getSelection?.() ?? windowRef.getSelection?.() ?? null;
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			return [];
		}
		const nodeFor = (node) => {
			const element =
				node?.nodeType === 1 ? node : (node?.parentElement ?? node?.parentNode);
			const root = element?.closest?.("[data-zmail-node][data-zmail-node-key]");
			return root
				? nodeToken({
						nodeId: root.dataset.zmailNode,
						key: root.dataset.zmailNodeKey,
					})
				: null;
		};
		return Array.from(
			new Set(
				[nodeFor(selection.anchorNode), nodeFor(selection.focusNode)].filter(
					Boolean,
				),
			),
		);
	}

	function requestWouldReplaceSelectedIsland(request) {
		if (request.source !== "sse" || !request.islands?.length) {
			return false;
		}
		const selected = selectedIslandIds();
		return request.islands.some((id) => selected.includes(id));
	}

	function requestWouldReplaceSelectedNode(request) {
		if (request.source !== "sse" || !request.nodes?.length) {
			return false;
		}
		const selected = selectedNodeTokens();
		return request.nodes.some((target) => selected.includes(nodeToken(target)));
	}

	function flushDeferredRefreshes() {
		const requests = Array.from(deferredRefreshes.values());
		clearDeferredRefreshes();
		for (const request of requests) {
			runScheduledRefresh(request);
		}
	}

	function deferRefreshUntilSelectionClears(key, request) {
		deferredRefreshes.set(
			key,
			mergeRefreshRequest(deferredRefreshes.get(key) ?? null, request),
		);
		debugRefresh("deferred-selected-island", {
			deferredKey: key,
			islands: request.islands,
			source: request.source,
		});
		if (selectionDeferredCleanup) {
			return;
		}
		const run = () => {
			if (selectedIslandIds().length === 0) {
				flushDeferredRefreshes();
			}
		};
		const runSoon = () => {
			windowRef.setTimeout?.(run, 0);
			run();
		};
		documentRef.addEventListener("selectionchange", run, true);
		documentRef.addEventListener("pointerup", runSoon, true);
		documentRef.addEventListener("keyup", runSoon, true);
		selectionDeferredCleanup = () => {
			documentRef.removeEventListener("selectionchange", run, true);
			documentRef.removeEventListener("pointerup", runSoon, true);
			documentRef.removeEventListener("keyup", runSoon, true);
		};
	}

	function deferRefreshUntilInactive(active, key, request) {
		deferredRefreshes.set(
			key,
			mergeRefreshRequest(deferredRefreshes.get(key) ?? null, request),
		);
		debugRefresh("deferred-active-island", {
			deferredKey: key,
			islands: request.islands,
			source: request.source,
		});
		if (deferredCleanup) {
			return;
		}
		const form = active.closest?.("form") ?? null;
		const cleanup = () => {
			active.removeEventListener("blur", run, true);
			active.removeEventListener("focusout", run, true);
			form?.removeEventListener("submit", run, true);
		};
		const run = () => {
			flushDeferredRefreshes();
		};
		active.addEventListener("blur", run, true);
		active.addEventListener("focusout", run, true);
		form?.addEventListener("submit", run, true);
		deferredCleanup = cleanup;
	}

	function runScheduledRefresh(request) {
		if (!sameRefreshOrigin(request)) {
			return;
		}
		if (
			request.source === "sse" &&
			!request.islands?.length &&
			!request.nodes?.length
		) {
			debugRefresh("main-fallback-blocked", {
				source: request.source,
				islands: request.islands,
				nodes: request.nodes,
			});
			return;
		}
		const active = activeEditElement();
		if (active && !request.islands?.length && !request.nodes?.length) {
			deferRefreshUntilInactive(active, "main", request);
			return;
		}
		if (request.islands?.length) {
			const activeSelectedIsland = activeIslandId(active);
			const selectedIslands =
				request.source === "sse" ? selectedIslandIds() : [];
			const deferredIslands = request.islands.filter(
				(id) => id === activeSelectedIsland || selectedIslands.includes(id),
			);
			if (deferredIslands.length > 0) {
				const readyIslands = request.islands.filter(
					(id) => !deferredIslands.includes(id),
				);
				for (const islandId of deferredIslands) {
					const deferredRequest = {
						...request,
						islands: [islandId],
						fallback: "none",
					};
					if (islandId === activeSelectedIsland && active) {
						deferRefreshUntilInactive(active, islandId, deferredRequest);
					} else {
						deferRefreshUntilSelectionClears(islandId, deferredRequest);
					}
				}
				if (readyIslands.length > 0) {
					void refresh({
						...request,
						islands: readyIslands,
						fallback: "none",
					});
				}
				return;
			}
		}
		if (request.source === "sse" && request.nodes?.length) {
			const blocked = new Set(
				[activeNodeToken(active), ...selectedNodeTokens()].filter(Boolean),
			);
			if (blocked.size > 0) {
				request = {
					...request,
					nodes: request.nodes.filter(
						(target) => !blocked.has(nodeToken(target)),
					),
				};
				if (!request.nodes.length && !request.islands?.length) {
					return;
				}
			}
		}
		void refresh(request);
	}

	function scheduleRefresh(options = {}) {
		const debounceMs = options.debounceMs ?? 1000;
		const maxWaitMs = options.maxWaitMs ?? 5000;
		const request = buildRefreshRequest({
			...options,
			originPage: options.originPage ?? currentPage(),
			originUrl: options.originUrl ?? currentUrl(),
		});
		if (
			options.immediate &&
			!activeEditElement() &&
			!requestWouldReplaceSelectedIsland(request) &&
			!requestWouldReplaceSelectedNode(request)
		) {
			clearScheduledRefresh();
			if (request.source !== "sse") {
				refreshQueued = null;
			}
			debugRefresh("scheduled-refresh", {
				islands: request.islands,
				nodes: request.nodes,
				source: request.source,
				fallback: request.fallback,
				originPage: request.originPage,
				originUrl: request.originUrl,
				immediate: true,
				debounceMs,
				maxWaitMs,
			});
			return refresh(request);
		}
		scheduledRefreshRequest = mergeRefreshRequest(
			scheduledRefreshRequest,
			request,
		);
		debugRefresh("scheduled-refresh", {
			islands: scheduledRefreshRequest?.islands,
			nodes: scheduledRefreshRequest?.nodes,
			source: scheduledRefreshRequest?.source,
			fallback: scheduledRefreshRequest?.fallback,
			originPage: scheduledRefreshRequest?.originPage,
			originUrl: scheduledRefreshRequest?.originUrl,
			immediate: Boolean(options.immediate),
			debounceMs,
			maxWaitMs,
		});
		if (scheduledRefreshTimer) {
			clearTimeout(scheduledRefreshTimer);
		}
		scheduledRefreshTimer = setTimeout(
			() => {
				scheduledRefreshTimer = null;
				if (scheduledRefreshMaxTimer) {
					clearTimeout(scheduledRefreshMaxTimer);
					scheduledRefreshMaxTimer = null;
				}
				runScheduledRefresh(takeScheduledRefreshRequest(request));
			},
			options.immediate ? 0 : debounceMs,
		);
		if (!scheduledRefreshMaxTimer) {
			scheduledRefreshMaxTimer = setTimeout(() => {
				scheduledRefreshMaxTimer = null;
				if (scheduledRefreshTimer) {
					clearTimeout(scheduledRefreshTimer);
					scheduledRefreshTimer = null;
				}
				runScheduledRefresh(takeScheduledRefreshRequest(request));
			}, maxWaitMs);
		}
		return Promise.resolve();
	}

	function bindLinkClicks() {
		const handler = (event) => {
			const link = eventElement(event)?.closest("a[href]");
			if (!link) {
				return;
			}
			if (link.target && link.target !== "_self") {
				return;
			}
			if (link.origin !== windowRef.location.origin) {
				return;
			}
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
				return;
			}
			event.preventDefault();
			void navigate(link.href, { source: "user" });
		};
		documentRef.addEventListener("click", handler);
		return () => documentRef.removeEventListener("click", handler);
	}

	function bindPopState() {
		const handler = () => {
			void navigate(
				`${windowRef.location.pathname}${windowRef.location.search}`,
				{ replace: true, history: false, source: "popstate" },
			);
		};
		windowRef.addEventListener("popstate", handler);
		return () => windowRef.removeEventListener("popstate", handler);
	}

	function bindPrefetch() {
		const handler = (event) => {
			const link = eventElement(event)?.closest("a[href]");
			if (!link || link.origin !== windowRef.location.origin) {
				return;
			}
			void fetchImpl(link.href, {
				headers: {
					...MAIN_PARTIAL_HEADERS,
					"X-Requested-With": "zmail-prefetch",
				},
			}).catch(() => {});
		};
		documentRef.addEventListener("mouseenter", handler, true);
		return () => documentRef.removeEventListener("mouseenter", handler, true);
	}

	return {
		navigate,
		refresh,
		refreshIsland,
		refreshNodes,
		scheduleRefresh,
		bindLinkClicks,
		bindPopState,
		bindPrefetch,
		currentMain,
	};
}
