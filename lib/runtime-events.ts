import { EventEmitter, once } from "node:events";

import { nowIso } from "#/lib/config";
import { getDb, getSqlite, jsonText, safeJsonParse } from "#/lib/db";
import { startTrace } from "#/lib/log";
import { currentOrgId } from "#/lib/runtime";

const MAX_RUNTIME_EVENTS = 20_000;
const MAX_RUNTIME_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

interface RuntimeEventInput {
	topic: string;
	eventType: string;
	entityKind?: string | null;
	entityId?: string | null;
	payload?: Record<string, unknown> | null;
	orgId?: string;
}

export interface RuntimeEventRecord {
	id: number;
	topic: string;
	eventType: string;
	entityKind: string | null;
	entityId: string | null;
	payload: Record<string, unknown>;
	createdAt: string;
}

declare global {
	var __zmailRuntimeEventEmitter__: EventEmitter | undefined;
	var __zmailPendingRuntimeEventTasks__: Set<Promise<unknown>> | undefined;
}

function eventEmitter() {
	if (!globalThis.__zmailRuntimeEventEmitter__) {
		globalThis.__zmailRuntimeEventEmitter__ = new EventEmitter();
		globalThis.__zmailRuntimeEventEmitter__.setMaxListeners(0);
	}
	return globalThis.__zmailRuntimeEventEmitter__;
}

function emitterKey(orgId: string) {
	return `runtime-event:${orgId}`;
}

function pendingRuntimeEventTasks() {
	if (!globalThis.__zmailPendingRuntimeEventTasks__) {
		globalThis.__zmailPendingRuntimeEventTasks__ = new Set();
	}
	return globalThis.__zmailPendingRuntimeEventTasks__;
}

export function trackRuntimeEventTask<T>(promise: Promise<T>) {
	const tasks = pendingRuntimeEventTasks();
	const tracked = promise.finally(() => {
		tasks.delete(tracked);
	});
	tasks.add(tracked);
	return tracked;
}

export async function flushRuntimeEventTasks() {
	const tasks = pendingRuntimeEventTasks();
	while (tasks.size > 0) {
		await Promise.allSettled([...tasks]);
	}
}

export async function publishRuntimeEvent(input: RuntimeEventInput) {
	const orgId = input.orgId ?? currentOrgId();
	const db = getDb(orgId);
	const createdAt = nowIso();
	const row = await db
		.insertInto("runtime_events")
		.values({
			topic: input.topic,
			event_type: input.eventType,
			entity_kind: input.entityKind ?? null,
			entity_id: input.entityId ?? null,
			payload_json: jsonText(input.payload ?? {}),
			created_at: createdAt,
		})
		.returning([
			"id",
			"topic",
			"event_type",
			"entity_kind",
			"entity_id",
			"payload_json",
			"created_at",
		])
		.executeTakeFirstOrThrow();
	const event = {
		id: row.id,
		topic: row.topic,
		eventType: row.event_type,
		entityKind: row.entity_kind,
		entityId: row.entity_id,
		payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
		createdAt: row.created_at,
	} satisfies RuntimeEventRecord;
	eventEmitter().emit(emitterKey(orgId), event);
	void trackRuntimeEventTask(pruneRuntimeEvents(orgId));
	return event;
}

export function latestRuntimeEventId(orgId = currentOrgId()) {
	const sqlite = getSqlite(orgId);
	const row = sqlite
		.prepare("SELECT coalesce(max(id), 0) AS id FROM runtime_events")
		.get() as { id: number | null };
	return Number(row.id ?? 0);
}

export async function listRuntimeEvents(input: {
	topics?: string[];
	cursor?: number | null;
	limit?: number;
	orgId?: string;
}) {
	const orgId = input.orgId ?? currentOrgId();
	const db = getDb(orgId);
	let query = db
		.selectFrom("runtime_events")
		.selectAll()
		.orderBy("id", "asc")
		.limit(input.limit ?? 200);
	if (input.cursor != null) {
		query = query.where("id", ">", input.cursor);
	}
	if (input.topics?.length) {
		query = query.where("topic", "in", input.topics);
	}
	const rows = await query.execute();
	return rows.map(
		(row) =>
			({
				id: row.id,
				topic: row.topic,
				eventType: row.event_type,
				entityKind: row.entity_kind,
				entityId: row.entity_id,
				payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
				createdAt: row.created_at,
			}) satisfies RuntimeEventRecord,
	);
}

export async function waitForRuntimeEvent(input: {
	topics?: string[];
	cursor?: number | null;
	timeoutMs?: number;
	orgId?: string;
}) {
	const orgId = input.orgId ?? currentOrgId();
	const initial = await listRuntimeEvents({
		topics: input.topics,
		cursor: input.cursor,
		limit: 1,
		orgId,
	});
	if (initial.length > 0) {
		return initial[0];
	}

	const emitter = eventEmitter();
	const key = emitterKey(orgId);
	const timeoutMs = input.timeoutMs ?? 15_000;

	while (true) {
		const timer = new Promise<null>((resolve) => {
			setTimeout(() => resolve(null), timeoutMs);
		});
		const event = await Promise.race([
			once(emitter, key).then(([next]) => next as RuntimeEventRecord),
			timer,
		]);
		if (!event) {
			return null;
		}
		if (!input.topics?.length || input.topics.includes(event.topic)) {
			return event;
		}
	}
}

export async function pruneRuntimeEvents(orgId = currentOrgId()) {
	const db = getDb(orgId);
	const cutoff = new Date(Date.now() - MAX_RUNTIME_EVENT_AGE_MS).toISOString();
	const row = await db
		.selectFrom("runtime_events")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.executeTakeFirstOrThrow();
	const total = Number(row.count);
	const keepFromId =
		total > MAX_RUNTIME_EVENTS ? total - MAX_RUNTIME_EVENTS : null;
	await db
		.deleteFrom("runtime_events")
		.where((eb) =>
			eb.or([
				eb("created_at", "<", cutoff),
				...(keepFromId == null ? [] : [eb("id", "<=", keepFromId)]),
			]),
		)
		.execute();
}

export function runtimeEventEnvelope(event: RuntimeEventRecord) {
	return {
		id: event.id,
		event: event.eventType,
		data: {
			topic: event.topic,
			entityKind: event.entityKind,
			entityId: event.entityId,
			createdAt: event.createdAt,
			payload: event.payload,
		},
	};
}

export async function publishActionEvent(input: RuntimeEventInput) {
	const trace = startTrace({
		kind: "event",
		operation: "publish_runtime_event",
		topic: input.topic,
		event_type: input.eventType,
		entity_kind: input.entityKind ?? undefined,
		entity_id: input.entityId ?? undefined,
	});
	const event = await publishRuntimeEvent(input);
	trace.complete("runtime.event.published", {
		event_id: event.id,
		org_id: input.orgId ?? currentOrgId(),
	});
	return event;
}
