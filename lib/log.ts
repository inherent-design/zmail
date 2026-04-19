import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import pino from "pino";

import { loadResolvedConfig } from "#/lib/app-config";

type LogLevel = "info" | "error";

type LogValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| Record<string, unknown>
	| Array<unknown>;

export type LogFields = Record<string, LogValue>;

interface TraceFields extends LogFields {
	request_id: string;
	trace_id: string;
	span_id: string;
	parent_span_id?: string;
}

export interface LogTrace {
	add(fields?: LogFields): LogTrace;
	child(fields?: LogFields): LogTrace;
	info(event: string, fields?: LogFields): void;
	complete(event: string, fields?: LogFields): void;
	fail(event: string, error: unknown, fields?: LogFields): void;
	fields(): Readonly<LogFields>;
}

export interface StartTraceInput extends LogFields {
	kind: string;
	operation: string;
	request_id?: string;
	trace_id?: string;
	span_id?: string;
	parent_span_id?: string;
}

const LOG_ENABLED =
	!(
		typeof process.env.VITEST === "string" || process.env.NODE_ENV === "test"
	) || process.env.VITEST_LOG === "true";

const SECRET_KEY_PATTERN =
	/(^|_)(access|refresh)?_?token$|authorization|api_?key|secret|password|credential|code_verifier/i;

const RESOLVED_CONFIG = loadResolvedConfig();
const loggerBase = {
	service: "zmail",
	version:
		process.env.ZMAIL_SERVICE_VERSION ??
		process.env.npm_package_version ??
		"dev",
	commit_hash: process.env.ZMAIL_COMMIT_SHA ?? "uncommitted",
	environment: process.env.NODE_ENV ?? "development",
	runtime: "node",
	service_instance_id: RESOLVED_CONFIG.observability.serviceInstanceId,
} as const;
const LOGGING_CONFIG = RESOLVED_CONFIG.logging;

function createLogStream() {
	const logFile = RESOLVED_CONFIG.observability.logFile;
	if (!LOG_ENABLED || !logFile) {
		return process.stdout;
	}

	mkdirSync(dirname(logFile), { recursive: true });
	return pino.multistream([
		{ stream: process.stdout },
		{ stream: pino.destination({ dest: logFile, sync: true }) },
	]);
}

export const logger = pino(
	{
		level: LOGGING_CONFIG.level,
		base: loggerBase,
		formatters: {
			level: (label) => ({ level: label }),
		},
		timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
		redact: {
			paths: [
				"authorization",
				"headers.authorization",
				"access_token",
				"accessToken",
				"refresh_token",
				"refreshToken",
				"api_key",
				"apiKey",
				"credentials",
				"oauth.credentials",
				"token",
				"tokens",
			],
			censor: "[REDACTED]",
		},
	},
	createLogStream(),
);

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return {
			type: error.name,
			message: error.message,
			stack: error.stack,
		};
	}

	return {
		type: typeof error,
		message: String(error),
		stack: undefined,
	};
}

function sanitizeValue(
	value: unknown,
	key: string | null,
	seen: WeakSet<object>,
): LogValue {
	if (value === undefined || value === null) {
		return value;
	}

	if (key && SECRET_KEY_PATTERN.test(key)) {
		return "[REDACTED]";
	}

	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeValue(entry, key, seen));
	}

	if (value instanceof Error) {
		return serializeError(value);
	}

	if (typeof value === "object") {
		if (seen.has(value as object)) {
			return "[Circular]";
		}

		seen.add(value as object);
		const sanitized: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(
			value as Record<string, unknown>,
		)) {
			const nextValue = sanitizeValue(entryValue, entryKey, seen);
			if (nextValue !== undefined) {
				sanitized[entryKey] = nextValue;
			}
		}
		seen.delete(value as object);
		return sanitized;
	}

	return value as string | number | boolean;
}

function sanitizeFields(fields: LogFields | undefined) {
	if (!fields) {
		return {};
	}

	const sanitized: Record<string, LogValue> = {};
	const seen = new WeakSet<object>();
	for (const [key, value] of Object.entries(fields)) {
		const nextValue = sanitizeValue(value, key, seen);
		if (nextValue !== undefined) {
			sanitized[key] = nextValue;
		}
	}
	return sanitized;
}

function emit(level: LogLevel, fields: LogFields) {
	if (!LOG_ENABLED) {
		return;
	}

	if (level === "error") {
		logger.error(fields);
		return;
	}

	logger.info(fields);
}

function durationSince(startedAt: number) {
	return Math.max(0, Date.now() - startedAt);
}

function createTrace(
	baseFields: TraceFields,
	startedAt = Date.now(),
): LogTrace {
	const state = {
		fields: { ...baseFields },
		startedAt,
	};

	return {
		add(fields) {
			Object.assign(state.fields, sanitizeFields(fields));
			return this;
		},
		child(fields) {
			const childFields = sanitizeFields(fields);
			return createTrace({
				...state.fields,
				...childFields,
				request_id: state.fields.request_id,
				trace_id: state.fields.trace_id,
				parent_span_id: state.fields.span_id,
				span_id:
					typeof childFields.span_id === "string"
						? childFields.span_id
						: randomUUID(),
			});
		},
		info(event, fields) {
			const safeFields = sanitizeFields(fields);
			emit("info", {
				...state.fields,
				...safeFields,
				event,
				outcome:
					typeof safeFields.outcome === "string"
						? safeFields.outcome
						: "in_progress",
				duration_ms: durationSince(state.startedAt),
			});
		},
		complete(event, fields) {
			emit("info", {
				...state.fields,
				...sanitizeFields(fields),
				event,
				outcome: "success",
				duration_ms: durationSince(state.startedAt),
			});
		},
		fail(event, error, fields) {
			emit("error", {
				...state.fields,
				...sanitizeFields(fields),
				event,
				outcome: "error",
				duration_ms: durationSince(state.startedAt),
				error: serializeError(error),
			});
		},
		fields() {
			return { ...state.fields };
		},
	};
}

export function startTrace(input: StartTraceInput): LogTrace {
	const safeInput = sanitizeFields(input);
	return createTrace({
		...safeInput,
		request_id:
			typeof safeInput.request_id === "string"
				? safeInput.request_id
				: randomUUID(),
		trace_id:
			typeof safeInput.trace_id === "string"
				? safeInput.trace_id
				: randomUUID(),
		span_id:
			typeof safeInput.span_id === "string" ? safeInput.span_id : randomUUID(),
	});
}
