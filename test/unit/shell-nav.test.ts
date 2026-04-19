import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import { createShellNav } from "#/public/client/core/shell-nav.js";

function createDom(url = "http://localhost/") {
	return new JSDOM(
		`<!DOCTYPE html>
		<html data-zmail-base-path="/" data-zmail-event-cursor="5">
			<head><title>Home</title></head>
			<body>
				<main id="app-main" class="page" data-page="home" data-event-cursor="5">
					<section>Initial</section>
				</main>
			</body>
		</html>`,
		{ url },
	);
}

function partialResponse(input: {
	page: string;
	title: string;
	cursor: number;
	body: string;
}) {
	return new Response(
		`<div id="app-main" class="page" data-page="${input.page}" data-event-cursor="${String(input.cursor)}">${input.body}</div>`,
		{
			status: 200,
			headers: {
				"X-Zmail-Title": input.title,
				"X-Zmail-Page": input.page,
				"X-Zmail-Event-Cursor": String(input.cursor),
			},
		},
	);
}

function deferredResponse() {
	let resolveResponse: ((response: Response) => void) | null = null;
	const promise = new Promise<Response>((resolve) => {
		resolveResponse = resolve;
	});
	return {
		promise,
		resolve(response: Response) {
			resolveResponse?.(response);
		},
	};
}

function abortableResponse() {
	let resolveResponse: ((response: Response) => void) | null = null;
	let rejectResponse: ((error: Error) => void) | null = null;
	const promise = new Promise<Response>((resolve, reject) => {
		resolveResponse = resolve;
		rejectResponse = reject;
	});
	return {
		promise,
		resolve(response: Response) {
			resolveResponse?.(response);
		},
		abort() {
			const error = new Error("aborted");
			error.name = "AbortError";
			rejectResponse?.(error);
		},
	};
}

describe("shell nav", () => {
	it("updates title, history, and the render-time cursor after navigate", async () => {
		const dom = createDom();
		vi.stubGlobal("DOMParser", dom.window.DOMParser);
		const onAfterSwap = vi.fn();
		const fetchImpl = vi.fn(async () =>
			partialResponse({
				page: "finance",
				title: "Finance",
				cursor: 9,
				body: "<section>Finance</section>",
			}),
		);
		const shellNav = createShellNav({
			documentRef: dom.window.document,
			windowRef: dom.window as unknown as Window,
			fetchImpl: fetchImpl as typeof fetch,
			onAfterSwap,
		});

		await shellNav.navigate("http://localhost/finance");

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(dom.window.document.title).toBe("Finance");
		expect(dom.window.location.pathname).toBe("/finance");
		expect(dom.window.document.documentElement.dataset.zmailEventCursor).toBe(
			"9",
		);
		expect(
			dom.window.document.getElementById("app-main")?.dataset.eventCursor,
		).toBe("9");
		expect(onAfterSwap).toHaveBeenCalledWith(
			"finance",
			"http://localhost/finance",
		);
	});

	it("coalesces repeated refresh requests into one in-flight refresh plus one trailing refresh", async () => {
		const dom = createDom();
		vi.stubGlobal("DOMParser", dom.window.DOMParser);
		const first = deferredResponse();
		const second = deferredResponse();
		const responses = [first.promise, second.promise];
		const fetchImpl = vi.fn(
			() => responses.shift() ?? Promise.reject(new Error("unexpected fetch")),
		);
		const shellNav = createShellNav({
			documentRef: dom.window.document,
			windowRef: dom.window as unknown as Window,
			fetchImpl: fetchImpl as typeof fetch,
			onAfterSwap: vi.fn(),
		});

		const refreshA = shellNav.refresh();
		const refreshB = shellNav.refresh();

		expect(fetchImpl).toHaveBeenCalledTimes(1);

		first.resolve(
			partialResponse({
				page: "home",
				title: "Home",
				cursor: 10,
				body: "<section>First refresh</section>",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fetchImpl).toHaveBeenCalledTimes(2);

		second.resolve(
			partialResponse({
				page: "home",
				title: "Home",
				cursor: 11,
				body: "<section>Second refresh</section>",
			}),
		);

		await Promise.all([refreshA, refreshB]);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(dom.window.document.documentElement.dataset.zmailEventCursor).toBe(
			"11",
		);
		expect(dom.window.document.body.textContent).toContain("Second refresh");
	});

	it("keeps user navigation when an older refresh resolves later", async () => {
		const dom = createDom();
		vi.stubGlobal("DOMParser", dom.window.DOMParser);
		const onAfterSwap = vi.fn();
		const refreshResponse = deferredResponse();
		const userResponse = deferredResponse();
		const responses = [refreshResponse.promise, userResponse.promise];
		const fetchImpl = vi.fn(
			() => responses.shift() ?? Promise.reject(new Error("unexpected fetch")),
		);
		const shellNav = createShellNav({
			documentRef: dom.window.document,
			windowRef: dom.window as unknown as Window,
			fetchImpl: fetchImpl as typeof fetch,
			onAfterSwap,
		});

		const refreshPromise = shellNav.refresh();
		const userNavigation = shellNav.navigate("http://localhost/accounts", {
			source: "user",
		});

		userResponse.resolve(
			partialResponse({
				page: "accounts",
				title: "Accounts",
				cursor: 12,
				body: "<section>Accounts page</section>",
			}),
		);
		await userNavigation;

		refreshResponse.resolve(
			partialResponse({
				page: "home",
				title: "Home",
				cursor: 13,
				body: "<section>Stale home</section>",
			}),
		);
		await refreshPromise;

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(dom.window.location.pathname).toBe("/accounts");
		expect(dom.window.document.title).toBe("Accounts");
		expect(dom.window.document.body.textContent).toContain("Accounts page");
		expect(dom.window.document.body.textContent).not.toContain("Stale home");
		expect(onAfterSwap).toHaveBeenCalledTimes(1);
		expect(onAfterSwap).toHaveBeenCalledWith(
			"accounts",
			"http://localhost/accounts",
		);
	});

	it("aborts an in-flight refresh when user navigation starts", async () => {
		const dom = createDom();
		vi.stubGlobal("DOMParser", dom.window.DOMParser);
		const refreshResponse = abortableResponse();
		const signals: AbortSignal[] = [];
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) => {
				if (init?.signal) {
					signals.push(init.signal);
				}
				if (signals.length === 1) {
					init?.signal?.addEventListener("abort", () =>
						refreshResponse.abort(),
					);
					return refreshResponse.promise;
				}
				return Promise.resolve(
					partialResponse({
						page: "accounts",
						title: "Accounts",
						cursor: 12,
						body: "<section>Accounts page</section>",
					}),
				);
			},
		);
		const shellNav = createShellNav({
			documentRef: dom.window.document,
			windowRef: dom.window as unknown as Window,
			fetchImpl: fetchImpl as typeof fetch,
			onAfterSwap: vi.fn(),
		});

		const refreshPromise = shellNav.refresh();
		const userNavigation = shellNav.navigate("http://localhost/accounts", {
			source: "user",
		});
		await Promise.all([refreshPromise, userNavigation]);

		expect(signals).toHaveLength(2);
		expect(signals[0].aborted).toBe(true);
		expect(dom.window.location.pathname).toBe("/accounts");
		expect(dom.window.document.body.textContent).toContain("Accounts page");
	});

	it("ignores a stale non-ok refresh response without replacing user navigation", async () => {
		const dom = createDom();
		vi.stubGlobal("DOMParser", dom.window.DOMParser);
		const refreshResponse = deferredResponse();
		const userResponse = deferredResponse();
		const responses = [refreshResponse.promise, userResponse.promise];
		const fetchImpl = vi.fn(
			() => responses.shift() ?? Promise.reject(new Error("unexpected fetch")),
		);
		const shellNav = createShellNav({
			documentRef: dom.window.document,
			windowRef: dom.window as unknown as Window,
			fetchImpl: fetchImpl as typeof fetch,
			onAfterSwap: vi.fn(),
		});

		const refreshPromise = shellNav.refresh();
		const userNavigation = shellNav.navigate("http://localhost/accounts", {
			source: "user",
		});
		userResponse.resolve(
			partialResponse({
				page: "accounts",
				title: "Accounts",
				cursor: 12,
				body: "<section>Accounts page</section>",
			}),
		);
		await userNavigation;

		refreshResponse.resolve(new Response("", { status: 500 }));
		await refreshPromise;

		expect(dom.window.location.pathname).toBe("/accounts");
		expect(dom.window.document.body.textContent).toContain("Accounts page");
	});

	it("clears scheduled refresh when user navigation starts", async () => {
		vi.useFakeTimers();
		try {
			const dom = createDom();
			vi.stubGlobal("DOMParser", dom.window.DOMParser);
			const fetchImpl = vi.fn(async () =>
				partialResponse({
					page: "accounts",
					title: "Accounts",
					cursor: 12,
					body: "<section>Accounts page</section>",
				}),
			);
			const shellNav = createShellNav({
				documentRef: dom.window.document,
				windowRef: dom.window as unknown as Window,
				fetchImpl: fetchImpl as typeof fetch,
				onAfterSwap: vi.fn(),
			});

			await shellNav.scheduleRefresh({ debounceMs: 1000, maxWaitMs: 5000 });
			await shellNav.navigate("http://localhost/accounts", { source: "user" });
			await vi.advanceTimersByTimeAsync(5000);

			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(dom.window.location.pathname).toBe("/accounts");
			expect(dom.window.document.body.textContent).toContain("Accounts page");
		} finally {
			vi.useRealTimers();
		}
	});
});
