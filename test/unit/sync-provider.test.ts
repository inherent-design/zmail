import { describe, expect, it, vi } from "vitest";

import { createSyncProvider } from "#/public/client/core/sync-provider.js";

class FakeEventSource {
	url: string;
	closed = false;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	#listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

	constructor(url: string) {
		this.url = url;
	}

	addEventListener(
		name: string,
		handler: (event: MessageEvent<string>) => void,
	) {
		const handlers = this.#listeners.get(name) ?? [];
		handlers.push(handler);
		this.#listeners.set(name, handlers);
	}

	close() {
		this.closed = true;
	}

	emit(name: string, event: MessageEvent<string>) {
		for (const handler of this.#listeners.get(name) ?? []) {
			handler(event);
		}
	}
}

function createFactory(instances: FakeEventSource[]) {
	return (url: string) => {
		const source = new FakeEventSource(url);
		instances.push(source);
		return source as unknown as EventSource;
	};
}

describe("sync provider", () => {
	it("connects with the render-time cursor on first subscribe", () => {
		const instances: FakeEventSource[] = [];
		const provider = createSyncProvider({
			basePath: "/",
			initialCursor: 12,
			eventSourceFactory: createFactory(instances),
		});

		provider.subscribe("jobs", () => {});

		expect(instances).toHaveLength(1);
		expect(instances[0].url).toBe("/events?topics=jobs&cursor=12");
	});

	it("advances the cursor from live events and uses it on reconnect", () => {
		const instances: FakeEventSource[] = [];
		const handler = vi.fn();
		const provider = createSyncProvider({
			basePath: "/",
			initialCursor: 5,
			eventSourceFactory: createFactory(instances),
		});

		provider.subscribe("jobs", handler);
		instances[0].emit("job.updated", {
			lastEventId: "7",
			data: JSON.stringify({ topic: "jobs", payload: { ok: true } }),
		} as MessageEvent<string>);
		provider.reconnect();

		expect(handler).toHaveBeenCalledTimes(1);
		expect(instances).toHaveLength(2);
		expect(instances[0].closed).toBe(true);
		expect(instances[1].url).toBe("/events?topics=jobs&cursor=7");
	});

	it("raises the cursor baseline without allowing it to move backward", () => {
		const instances: FakeEventSource[] = [];
		const provider = createSyncProvider({
			basePath: "/",
			initialCursor: 5,
			eventSourceFactory: createFactory(instances),
		});

		provider.subscribe("jobs", () => {});
		provider.setCursor(9);
		provider.setCursor(4);
		provider.reconnect();

		expect(instances).toHaveLength(2);
		expect(instances[1].url).toBe("/events?topics=jobs&cursor=9");
	});
});
