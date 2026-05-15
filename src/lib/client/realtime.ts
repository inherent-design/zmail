import type { ZmailInvalidationKey } from "#/lib/client-contract";
import { invalidateZmail } from "./invalidation";

export type ClientMessage =
	| { type: "subscribe"; topics: string[]; cursor?: number | null }
	| { type: "unsubscribe"; topics: string[] }
	| { type: "ping"; id?: string };

export type ServerMessage =
	| { type: "ready"; cursor: number; topics: string[] }
	| {
			type: "runtime.event";
			id: number;
			event: string;
			topic: string;
			data: unknown;
	  }
	| { type: "heartbeat"; at: string; cursor: number }
	| { type: "error"; error: string; message?: string }
	| { type: "pong"; id?: string };

const topicInvalidations: Record<string, ZmailInvalidationKey[]> = {
	accounts: ["zmail:accounts"],
	finance: ["zmail:finance"],
	jobs: ["zmail:runs", "zmail:home"],
	messages: ["zmail:messages", "zmail:review"],
	review: ["zmail:review"],
};

export function connectRealtime(topics: string[]) {
	if (typeof window === "undefined") {
		return () => {};
	}
	let closed = false;
	let socket: WebSocket | null = null;
	let cursor = Number(sessionStorage.getItem("zmail.ws.cursor") ?? "0");
	let retryMs = 500;

	const open = () => {
		const url = new URL("/ws", window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		socket = new WebSocket(url);
		socket.addEventListener("open", () => {
			retryMs = 500;
			socket?.send(
				JSON.stringify({
					type: "subscribe",
					topics,
					cursor,
				} satisfies ClientMessage),
			);
		});
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			if (message.type === "runtime.event") {
				cursor = Math.max(cursor, message.id);
				sessionStorage.setItem("zmail.ws.cursor", String(cursor));
				void invalidateZmail(topicInvalidations[message.topic] ?? []);
			}
			if (message.type === "heartbeat") {
				cursor = Math.max(cursor, message.cursor);
				sessionStorage.setItem("zmail.ws.cursor", String(cursor));
			}
		});
		socket.addEventListener("close", () => {
			socket = null;
			if (closed) {
				return;
			}
			const delay = retryMs;
			retryMs = Math.min(retryMs * 2, 10_000);
			setTimeout(open, delay);
		});
	};

	open();
	return () => {
		closed = true;
		socket?.close();
	};
}
