const PARTIAL_HEADERS = {
	"X-Zmail-Partial": "main",
};

export function extractPartialMain(html, parser = new DOMParser()) {
	const doc = parser.parseFromString(html, "text/html");
	return doc.getElementById("app-main");
}

export function createShellNav(input) {
	const {
		documentRef = document,
		windowRef = window,
		fetchImpl = fetch,
		onAfterSwap,
	} = input;
	let refreshInFlight = null;
	let refreshQueued = false;
	let scheduledRefreshTimer = null;
	let scheduledRefreshMaxTimer = null;
	let deferredUntilBlur = false;
	let navigationSerial = 0;
	let activeNavigation = null;

	function currentMain() {
		return documentRef.getElementById("app-main");
	}

	function currentUrl() {
		return `${windowRef.location.pathname}${windowRef.location.search}`;
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
			refreshQueued = false;
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

	async function navigate(url, options = {}) {
		const nextUrl = typeof url === "string" ? url : url.toString();
		const navigation = beginNavigation(options.source ?? "action");
		if (!navigation) {
			return;
		}

		try {
			const response = await fetchImpl(nextUrl, {
				headers: {
					...PARTIAL_HEADERS,
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
			const eventCursor =
				response.headers.get("X-Zmail-Event-Cursor") ||
				incomingMain.dataset.eventCursor;
			if (eventCursor) {
				documentRef.documentElement.dataset.zmailEventCursor = eventCursor;
			}
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

	async function refresh() {
		clearScheduledRefresh();
		refreshQueued = true;
		if (!refreshInFlight) {
			refreshInFlight = (async () => {
				try {
					while (refreshQueued) {
						refreshQueued = false;
						await navigate(currentUrl(), {
							replace: true,
							source: "refresh",
						});
					}
				} finally {
					refreshInFlight = null;
				}
			})();
		}
		return refreshInFlight;
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

	function runScheduledRefresh() {
		const active = activeEditElement();
		if (active && !deferredUntilBlur) {
			deferredUntilBlur = true;
			const onBlur = () => {
				deferredUntilBlur = false;
				active.removeEventListener("blur", onBlur, true);
				void refresh();
			};
			active.addEventListener("blur", onBlur, true);
			return;
		}
		deferredUntilBlur = false;
		void refresh();
	}

	function scheduleRefresh(options = {}) {
		const debounceMs = options.debounceMs ?? 1000;
		const maxWaitMs = options.maxWaitMs ?? 5000;
		if (options.immediate && !activeEditElement()) {
			return refresh();
		}
		if (scheduledRefreshTimer) {
			clearTimeout(scheduledRefreshTimer);
		}
		scheduledRefreshTimer = setTimeout(
			() => {
				scheduledRefreshTimer = null;
				runScheduledRefresh();
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
				void refresh();
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
					...PARTIAL_HEADERS,
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
		scheduleRefresh,
		bindLinkClicks,
		bindPopState,
		bindPrefetch,
		currentMain,
	};
}
