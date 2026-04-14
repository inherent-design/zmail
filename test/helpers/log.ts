import { vi } from "vitest";

import type { LogFields, LogTrace } from "#/lib/log";

type LogRecord =
	| {
			type: "start";
			input: LogFields;
	  }
	| {
			type: "add" | "child";
			trace_id: number;
			fields: LogFields;
	  }
	| {
			type: "info" | "complete";
			trace_id: number;
			event: string;
			fields: LogFields;
	  }
	| {
			type: "fail";
			trace_id: number;
			event: string;
			error: unknown;
			fields: LogFields;
	  };

export function createMockLogModule() {
	const records: LogRecord[] = [];
	let traceId = 0;

	function buildTrace(initialFields: LogFields = {}): LogTrace {
		const id = ++traceId;
		const context: LogFields = { ...initialFields };
		const trace: LogTrace = {
			add: vi.fn((fields: LogFields = {}) => {
				records.push({
					type: "add",
					trace_id: id,
					fields,
				});
				Object.assign(context, fields);
				return trace;
			}),
			child: vi.fn((fields: LogFields = {}) => {
				records.push({
					type: "child",
					trace_id: id,
					fields,
				});
				return buildTrace({ ...context, ...fields });
			}),
			info: vi.fn((event: string, fields: LogFields = {}) => {
				records.push({
					type: "info",
					trace_id: id,
					event,
					fields,
				});
			}),
			complete: vi.fn((event: string, fields: LogFields = {}) => {
				records.push({
					type: "complete",
					trace_id: id,
					event,
					fields,
				});
			}),
			fail: vi.fn((event: string, error: unknown, fields: LogFields = {}) => {
				records.push({
					type: "fail",
					trace_id: id,
					event,
					error,
					fields,
				});
			}),
			fields: vi.fn(() => ({ ...context })),
		};

		return trace;
	}

	const startTrace = vi.fn((input: LogFields) => {
		records.push({
			type: "start",
			input,
		});
		return buildTrace(input);
	});

	return {
		module: {
			logger: {
				info: vi.fn(),
				error: vi.fn(),
			},
			startTrace,
		},
		records,
		startTrace,
	};
}
