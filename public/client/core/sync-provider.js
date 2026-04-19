import {
	buildEventsUrl,
	normalizeTopics,
	parseEventPayload,
	SSE_EVENTS,
} from "./realtime.js";

export function createSyncProvider(input = {}) {
	const {
		basePath = "/",
		initialCursor = null,
		eventSourceFactory = (url) => new EventSource(url),
	} = input;

	let eventSource = null;
	let reconnectTimer = null;
	let reconnectDelayMs = 1000;
	let lastEventId = normalizeCursor(initialCursor);

	const topicHandlers = new Map();

	function normalizeCursor(value) {
		if (value == null || value === "") {
			return null;
		}
		const parsed = Number.parseInt(String(value), 10);
		return Number.isFinite(parsed) ? parsed : null;
	}

	function topicsSnapshot() {
		return normalizeTopics(topicHandlers.keys());
	}

	function notifyTopic(topic, event) {
		const handlers = topicHandlers.get(topic);
		if (!handlers) {
			return;
		}
		for (const handler of handlers) {
			handler(event);
		}
	}

	function disconnect() {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	}

	function connect() {
		disconnect();
		const topics = topicsSnapshot();
		if (topics.length === 0) {
			return;
		}
		const url = buildEventsUrl({
			topics,
			cursor: lastEventId,
			basePath,
		});
		eventSource = eventSourceFactory(url);
		eventSource.onerror = () => {
			disconnect();
			reconnectTimer = setTimeout(() => {
				reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000);
				connect();
			}, reconnectDelayMs);
		};
		eventSource.onopen = () => {
			reconnectDelayMs = 1000;
		};

		for (const eventName of SSE_EVENTS) {
			eventSource.addEventListener(eventName, (event) => {
				lastEventId = normalizeCursor(event.lastEventId) ?? lastEventId;
				const payload = parseEventPayload(event.data);
				notifyTopic(payload.topic, { ...payload, eventType: eventName });
			});
		}

		eventSource.addEventListener("heartbeat", (event) => {
			lastEventId = normalizeCursor(event.lastEventId) ?? lastEventId;
		});
	}

	function setCursor(cursor) {
		const normalized = normalizeCursor(cursor);
		if (normalized == null) {
			return;
		}
		if (lastEventId == null || normalized > lastEventId) {
			lastEventId = normalized;
		}
	}

	function subscribe(topic, handler) {
		const normalized = normalizeTopics([topic])[0];
		if (!normalized) {
			return () => {};
		}
		const set = topicHandlers.get(normalized) ?? new Set();
		const wasMissing = !topicHandlers.has(normalized);
		set.add(handler);
		topicHandlers.set(normalized, set);
		if (wasMissing) {
			connect();
		}
		return () => {
			const next = topicHandlers.get(normalized);
			if (!next) {
				return;
			}
			next.delete(handler);
			if (next.size === 0) {
				topicHandlers.delete(normalized);
				connect();
			}
		};
	}

	function mountTopics(topics) {
		const unsubscribers = normalizeTopics(topics).map((topic) =>
			subscribe(topic, () => {}),
		);
		return () => {
			for (const unsubscribe of unsubscribers) {
				unsubscribe();
			}
		};
	}

	return {
		subscribe,
		mountTopics,
		reconnect: connect,
		close: disconnect,
		setCursor,
	};
}
