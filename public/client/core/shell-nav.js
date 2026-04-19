const MAIN_PARTIAL_HEADERS = {
	"X-Zmail-Partial": "main",
};

const ISLAND_PARTIAL_HEADERS = {
	"X-Zmail-Partial": "islands",
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

function splitHeaderList(value) {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
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

export function createShellNav(input = {}) {
	const {
		documentRef = document,
		windowRef = window,
		fetchImpl = fetch,
		onAfterSwap,
		onBeforeIslandSwap,
		onAfterIslandSwap,
	} = input;
	let refreshInFlight = null;
	let refreshQueued = null;
	let scheduledRefreshTimer = null;
	let scheduledRefreshMaxTimer = null;
	let scheduledRefreshRequest = null;
	let deferredUntilBlur = false;
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

	function buildRefreshRequest(options = {}) {
		return {
			islands: normalizeIslandIds(options.islands),
			originPage: options.originPage ?? null,
			originUrl: normalizeUrl(options.originUrl) ?? null,
		};
	}

	function sameRefreshOrigin(request) {
		if (request.originPage && request.originPage !== currentPage()) {
			return false;
		}
		if (request.originUrl && request.originUrl !== currentUrl()) {
			return false;
		}
		return true;
	}

	function mergeRefreshRequest(current, next) {
		if (!current) {
			return next;
		}
		if (!current.islands || !next.islands) {
			return { ...next, islands: null };
		}
		return {
			...next,
			islands: Array.from(new Set([...current.islands, ...next.islands])),
		};
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
				await fallbackMainRefresh(request);
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
			const unsupported = request.islands.some(
				(id) => !roots.has(id) || !supportedIds.includes(id),
			);
			if (!envelope || missingIds.length > 0 || unsupported) {
				await fallbackMainRefresh(request);
				return;
			}
			const replacements = [];
			for (const id of request.islands) {
				const currentRoot = documentRef.querySelector(islandSelector(id));
				const incomingRoot = roots.get(id);
				if (!currentRoot || !incomingRoot) {
					await fallbackMainRefresh(request);
					return;
				}
				replacements.push({
					id,
					currentRoot,
					incomingRoot,
					state: onBeforeIslandSwap?.(id, currentRoot),
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

	async function performRefresh(request) {
		if (!sameRefreshOrigin(request)) {
			return;
		}
		if (request.islands?.length) {
			await refreshIslandsNow(request);
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

	function runScheduledRefresh(request) {
		if (!sameRefreshOrigin(request)) {
			return;
		}
		const active = activeEditElement();
		if (active && !deferredUntilBlur) {
			deferredUntilBlur = true;
			const onBlur = () => {
				deferredUntilBlur = false;
				active.removeEventListener("blur", onBlur, true);
				void refresh(request);
			};
			active.addEventListener("blur", onBlur, true);
			return;
		}
		deferredUntilBlur = false;
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
		scheduledRefreshRequest = mergeRefreshRequest(
			scheduledRefreshRequest,
			request,
		);
		if (options.immediate && !activeEditElement()) {
			return refresh(scheduledRefreshRequest ?? request);
		}
		if (scheduledRefreshTimer) {
			clearTimeout(scheduledRefreshTimer);
		}
		scheduledRefreshTimer = setTimeout(
			() => {
				scheduledRefreshTimer = null;
				runScheduledRefresh(scheduledRefreshRequest ?? request);
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
				void refresh(scheduledRefreshRequest ?? request);
			}, maxWaitMs);
		}
		return Promise.resolve();
	}

	function bindLinkClicks() {
		const handler = (event) => {
			const link = event.target.closest("a[href]");
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
			const link = event.target.closest("a[href]");
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
		scheduleRefresh,
		bindLinkClicks,
		bindPopState,
		bindPrefetch,
		currentMain,
	};
}
