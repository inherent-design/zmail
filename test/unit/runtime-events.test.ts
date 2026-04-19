import { describe, expect, it } from "vitest";

import { bootDb } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("runtime events", () => {
	it("reports the latest runtime event cursor", async () => {
		const runtime = await createTestRuntime();
		await bootDb();
		const runtimeEvents = await runtime.importFresh<
			typeof import("#/lib/runtime-events")
		>("#/lib/runtime-events");

		expect(runtimeEvents.latestRuntimeEventId()).toBe(0);

		const first = await runtimeEvents.publishActionEvent({
			topic: "jobs",
			eventType: "job.queued",
			entityKind: "job",
			entityId: "job-1",
			payload: { jobId: "job-1" },
		});
		expect(runtimeEvents.latestRuntimeEventId()).toBe(first.id);

		const second = await runtimeEvents.publishActionEvent({
			topic: "accounts",
			eventType: "account.sync_status",
			entityKind: "account",
			entityId: "acct-1",
			payload: { accountId: "acct-1" },
		});
		expect(second.id).toBeGreaterThan(first.id);
		expect(runtimeEvents.latestRuntimeEventId()).toBe(second.id);
	});
});
