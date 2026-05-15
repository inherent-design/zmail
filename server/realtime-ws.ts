import type { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { z } from "zod";

import {
	latestRuntimeEventId,
	listRuntimeEvents,
	runtimeEventEnvelope,
	waitForRuntimeEvent,
} from "#/lib/runtime-events";
import {
	activeBrowserOrgMiddleware,
	browserSessionMiddleware,
	requireOrgRole,
} from "#/server/auth";

export const clientWsMessageSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("subscribe"),
			topics: z.array(z.string().min(1)),
			cursor: z.number().int().nonnegative().nullable().optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("unsubscribe"),
			topics: z.array(z.string().min(1)),
		})
		.strict(),
	z
		.object({
			type: z.literal("ping"),
			id: z.string().optional(),
		})
		.strict(),
]);

export type ClientWsMessage = z.infer<typeof clientWsMessageSchema>;

export type ServerWsMessage =
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

function sendJson(ws: WSContext, message: ServerWsMessage) {
	if (ws.readyState === 1) {
		ws.send(JSON.stringify(message));
	}
}

function uniqueTopics(topics: readonly string[]) {
	return [
		...new Set(topics.map((topic) => topic.trim()).filter(Boolean)),
	].sort();
}

function runtimeEventMessage(
	event: Awaited<ReturnType<typeof listRuntimeEvents>>[number],
): ServerWsMessage {
	const envelope = runtimeEventEnvelope(event);
	return {
		type: "runtime.event",
		id: envelope.id,
		event: envelope.event,
		topic: event.topic,
		data: envelope.data,
	};
}

export function mountRealtimeWebSocket(
	app: Hono,
	upgradeWebSocket: UpgradeWebSocket,
) {
	app.get(
		"/ws",
		browserSessionMiddleware,
		activeBrowserOrgMiddleware,
		requireOrgRole("org_viewer"),
		upgradeWebSocket((c) => {
			const orgId = c.get("orgId");
			let closed = false;
			let subscribed = false;
			let topics: string[] = [];
			let cursor = latestRuntimeEventId(orgId);

			const pump = async (ws: WSContext) => {
				while (!closed) {
					if (!subscribed) {
						await new Promise((resolve) => setTimeout(resolve, 100));
						continue;
					}
					const next = await waitForRuntimeEvent({
						topics,
						cursor,
						timeoutMs: 15_000,
						orgId,
					});
					if (!next) {
						sendJson(ws, {
							type: "heartbeat",
							at: new Date().toISOString(),
							cursor,
						});
						continue;
					}
					cursor = next.id;
					sendJson(ws, runtimeEventMessage(next));
				}
			};

			return {
				onOpen(_event, ws) {
					sendJson(ws, { type: "ready", cursor, topics });
					void pump(ws);
				},
				async onMessage(event, ws) {
					let message: ClientWsMessage;
					try {
						message = clientWsMessageSchema.parse(
							JSON.parse(String(event.data)),
						);
					} catch (error) {
						sendJson(ws, {
							type: "error",
							error: "invalid_message",
							message:
								error instanceof Error
									? error.message
									: "Invalid WebSocket message.",
						});
						return;
					}
					if (message.type === "ping") {
						sendJson(ws, { type: "pong", id: message.id });
						return;
					}
					if (message.type === "unsubscribe") {
						const removed = new Set(message.topics);
						topics = topics.filter((topic) => !removed.has(topic));
						sendJson(ws, { type: "ready", cursor, topics });
						return;
					}

					topics = uniqueTopics(message.topics);
					cursor = message.cursor ?? latestRuntimeEventId(orgId);
					subscribed = true;
					const replay = await listRuntimeEvents({
						topics,
						cursor,
						limit: 200,
						orgId,
					});
					for (const item of replay) {
						cursor = item.id;
						sendJson(ws, runtimeEventMessage(item));
					}
					sendJson(ws, { type: "ready", cursor, topics });
				},
				onClose() {
					closed = true;
				},
				onError() {
					closed = true;
				},
			};
		}),
	);
}
