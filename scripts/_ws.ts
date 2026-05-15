export interface ParsedWsMessage {
	type: string;
	id?: number;
	event?: string;
	topic?: string;
	cursor?: number;
	data?: unknown;
}

export function normalizeWsTopics(topics: readonly string[]) {
	return [
		...new Set(topics.map((topic) => topic.trim()).filter(Boolean)),
	].sort();
}

export function buildWebSocketUrl(input: { baseUrl: string; path?: string }) {
	const url = new URL(input.path ?? "/ws", input.baseUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

export async function openWebSocketClient(input: {
	url: string;
	topics: readonly string[];
	cursor?: number | null;
	signal: AbortSignal;
	onMessage: (message: ParsedWsMessage) => void | Promise<void>;
}) {
	const socket = new WebSocket(input.url);
	let settled = false;

	return new Promise<void>((resolve, reject) => {
		const finish = (error?: unknown) => {
			if (settled) {
				return;
			}
			settled = true;
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};

		const close = () => {
			if (
				socket.readyState === WebSocket.OPEN ||
				socket.readyState === WebSocket.CONNECTING
			) {
				socket.close();
			}
			finish();
		};

		input.signal.addEventListener("abort", close, { once: true });
		socket.addEventListener("open", () => {
			socket.send(
				JSON.stringify({
					type: "subscribe",
					topics: normalizeWsTopics(input.topics),
					cursor: input.cursor ?? null,
				}),
			);
		});
		socket.addEventListener("message", (event) => {
			void Promise.resolve()
				.then(() => input.onMessage(JSON.parse(String(event.data))))
				.catch(finish);
		});
		socket.addEventListener("error", () => {
			finish(new Error(`WebSocket failed for ${input.url}`));
		});
		socket.addEventListener("close", () => finish());
	});
}
