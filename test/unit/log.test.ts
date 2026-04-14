import { describe, expect, it, vi } from "vitest";

import { setEnv } from "#/test/helpers/env";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("log", () => {
	it("does not emit logs during tests unless VITEST_LOG is enabled", async () => {
		const runtime = await createTestRuntime();
		setEnv({
			VITEST: undefined,
			VITEST_LOG: undefined,
			NODE_ENV: "test",
		});
		vi.resetModules();
		const writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as never);

		const log =
			await runtime.importFresh<typeof import("#/lib/log")>("#/lib/log");
		const trace = log.startTrace({
			kind: "test",
			operation: "silent",
		});
		trace.info("test.silent");

		expect(writeSpy).not.toHaveBeenCalled();
	});

	it("emits accumulated fields, child spans, redaction, and failures when enabled", async () => {
		const runtime = await createTestRuntime();
		setEnv({
			VITEST: undefined,
			VITEST_LOG: "true",
			NODE_ENV: undefined,
		});
		vi.resetModules();

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
		) => {
			writes.push(String(chunk));
			return true;
		}) as never);

		const log =
			await runtime.importFresh<typeof import("#/lib/log")>("#/lib/log");
		const trace = log.startTrace({
			kind: "test",
			operation: "root",
			request_id: "req-1",
			trace_id: "trace-1",
		});
		trace.add({
			account_id: "acct-1",
			accessToken: "secret-access",
		});

		const child = trace.child({
			operation: "child",
		});
		child.complete("test.child.complete", {
			api_key: "secret-key",
			processed: 25,
		});
		trace.fail("test.root.fail", new Error("boom"), {
			refresh_token: "secret-refresh",
		});

		const events = writes.map((entry) => JSON.parse(entry.trim())) as Array<
			Record<string, unknown>
		>;

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			event: "test.child.complete",
			kind: "test",
			operation: "child",
			request_id: "req-1",
			trace_id: "trace-1",
			account_id: "acct-1",
			processed: 25,
			outcome: "success",
			accessToken: "[REDACTED]",
			api_key: "[REDACTED]",
		});
		expect(events[0]?.span_id).not.toBe(events[1]?.span_id);
		expect(events[0]?.parent_span_id).toBe(events[1]?.span_id);
		expect(typeof events[0]?.duration_ms).toBe("number");

		expect(events[1]).toMatchObject({
			event: "test.root.fail",
			kind: "test",
			operation: "root",
			request_id: "req-1",
			trace_id: "trace-1",
			account_id: "acct-1",
			outcome: "error",
			accessToken: "[REDACTED]",
			refresh_token: "[REDACTED]",
			error: {
				type: "Error",
				message: "boom",
			},
		});
		expect(typeof events[1]?.duration_ms).toBe("number");
	});

	it("serializes arrays, nested errors, circular objects, and explicit span ids", async () => {
		const runtime = await createTestRuntime();
		setEnv({
			VITEST: undefined,
			VITEST_LOG: "true",
			NODE_ENV: undefined,
			ZMAIL_SERVICE_VERSION: undefined,
			ZMAIL_COMMIT_SHA: undefined,
		});
		vi.resetModules();

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
		) => {
			writes.push(String(chunk));
			return true;
		}) as never);

		const log =
			await runtime.importFresh<typeof import("#/lib/log")>("#/lib/log");
		const root = log.startTrace({
			kind: "test",
			operation: "root",
			request_id: "req-explicit",
			trace_id: "trace-explicit",
			span_id: "span-root",
		});
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		root.info("test.root.info", {
			outcome: "custom",
			items: [1, { token: "secret-token" }, new Error("nested-boom")],
			payload: circular,
			ignored: undefined,
		});

		const child = root.child({
			operation: "child",
			span_id: "span-child",
		});
		expect(child.fields()).toMatchObject({
			request_id: "req-explicit",
			trace_id: "trace-explicit",
			parent_span_id: "span-root",
			span_id: "span-child",
			operation: "child",
		});

		child.fail("test.child.fail", "plain failure");

		const events = writes.map((entry) => JSON.parse(entry.trim())) as Array<
			Record<string, unknown>
		>;

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			event: "test.root.info",
			environment: "development",
			version: "dev",
			commit_hash: "uncommitted",
			outcome: "custom",
			items: [
				1,
				{ token: "[REDACTED]" },
				{
					type: "Error",
					message: "nested-boom",
				},
			],
			payload: {
				self: "[Circular]",
			},
		});
		expect(events[1]).toMatchObject({
			event: "test.child.fail",
			request_id: "req-explicit",
			trace_id: "trace-explicit",
			parent_span_id: "span-root",
			span_id: "span-child",
			error: {
				type: "string",
				message: "plain failure",
			},
		});
	});
});
