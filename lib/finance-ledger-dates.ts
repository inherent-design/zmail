export type LedgerDatePrecision =
	| "day"
	| "datetime"
	| "month"
	| "year"
	| "unknown";

export type LedgerDateSource = "occurred_at" | "posted_at" | "cleared_at";
export type LedgerDateRecovery = Record<string, unknown>;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ].+)$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_RE = /^(\d{4})$/;

export interface ClassifiedLedgerDate {
	value: string | null;
	precision: LedgerDatePrecision;
	beancountDate: string | null;
	exact: boolean;
}

function normalizedValue(value: string | null | undefined) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function validDateParts(year: number, month: number, day: number) {
	if (
		!Number.isInteger(year) ||
		!Number.isInteger(month) ||
		!Number.isInteger(day)
	) {
		return false;
	}
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return false;
	}
	const probe = new Date(Date.UTC(year, month - 1, day));
	return (
		probe.getUTCFullYear() === year &&
		probe.getUTCMonth() === month - 1 &&
		probe.getUTCDate() === day
	);
}

function validMonthParts(year: number, month: number) {
	return (
		Number.isInteger(year) &&
		Number.isInteger(month) &&
		month >= 1 &&
		month <= 12
	);
}

function pruneNullish(value: LedgerDateRecovery) {
	return Object.fromEntries(
		Object.entries(value).filter(
			([, entry]) => entry !== null && entry !== undefined,
		),
	);
}

function metadataDateRecovery(metadataJson: unknown) {
	if (typeof metadataJson !== "string" || !metadataJson.trim()) {
		return null;
	}
	try {
		const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
		return parsed.dateRecovery &&
			typeof parsed.dateRecovery === "object" &&
			!Array.isArray(parsed.dateRecovery)
			? (parsed.dateRecovery as LedgerDateRecovery)
			: null;
	} catch {
		return null;
	}
}

export function classifyLedgerDate(
	value: string | null | undefined,
): ClassifiedLedgerDate {
	const normalized = normalizedValue(value);
	if (!normalized) {
		return {
			value: null,
			precision: "unknown",
			beancountDate: null,
			exact: false,
		};
	}

	const dayMatch = normalized.match(DAY_RE);
	if (dayMatch) {
		const year = Number.parseInt(dayMatch[1] ?? "", 10);
		const month = Number.parseInt(dayMatch[2] ?? "", 10);
		const day = Number.parseInt(dayMatch[3] ?? "", 10);
		if (validDateParts(year, month, day)) {
			return {
				value: normalized,
				precision: "day",
				beancountDate: normalized,
				exact: true,
			};
		}
	}

	const datetimeMatch = normalized.match(DATETIME_RE);
	if (datetimeMatch) {
		const year = Number.parseInt(datetimeMatch[1] ?? "", 10);
		const month = Number.parseInt(datetimeMatch[2] ?? "", 10);
		const day = Number.parseInt(datetimeMatch[3] ?? "", 10);
		if (validDateParts(year, month, day)) {
			return {
				value: normalized,
				precision: "datetime",
				beancountDate: normalized.slice(0, 10),
				exact: true,
			};
		}
	}

	const monthMatch = normalized.match(MONTH_RE);
	if (monthMatch) {
		const year = Number.parseInt(monthMatch[1] ?? "", 10);
		const month = Number.parseInt(monthMatch[2] ?? "", 10);
		if (validMonthParts(year, month)) {
			return {
				value: normalized,
				precision: "month",
				beancountDate: null,
				exact: false,
			};
		}
	}

	const yearMatch = normalized.match(YEAR_RE);
	if (yearMatch) {
		const year = Number.parseInt(yearMatch[1] ?? "", 10);
		if (Number.isInteger(year) && year >= 1900 && year <= 2500) {
			return {
				value: normalized,
				precision: "year",
				beancountDate: null,
				exact: false,
			};
		}
	}

	return {
		value: normalized,
		precision: "unknown",
		beancountDate: null,
		exact: false,
	};
}

export function precisionForLedgerDate(value: string | null | undefined) {
	return classifyLedgerDate(value).precision;
}

export function isExactLedgerDate(value: string | null | undefined) {
	return classifyLedgerDate(value).exact;
}

export function toBeancountDate(value: string | null | undefined) {
	return classifyLedgerDate(value).beancountDate;
}

function readInputValue(
	input: {
		occurred_at?: string | null;
		posted_at?: string | null;
		cleared_at?: string | null;
		occurredAt?: string | null;
		postedAt?: string | null;
		clearedAt?: string | null;
	},
	snakeKey: LedgerDateSource,
	camelKey: "occurredAt" | "postedAt" | "clearedAt",
) {
	const raw = input[snakeKey] ?? input[camelKey];
	return typeof raw === "string" ? raw : raw === null ? null : undefined;
}

export function resolveBeancountDate(row: {
	occurred_at?: string | null;
	posted_at?: string | null;
	cleared_at?: string | null;
	ledger_metadata_json?: string;
}) {
	const candidates: Array<{
		source: LedgerDateSource;
		value: string | null | undefined;
	}> = [
		{ source: "occurred_at", value: row.occurred_at },
		{ source: "posted_at", value: row.posted_at },
		{ source: "cleared_at", value: row.cleared_at },
	];

	for (const candidate of candidates) {
		const beancountDate = toBeancountDate(candidate.value);
		if (beancountDate) {
			return {
				beancountDate,
				beancountDateSource: candidate.source,
				dateRecovery: metadataDateRecovery(row.ledger_metadata_json),
			};
		}
	}

	return {
		beancountDate: null,
		beancountDateSource: null,
		dateRecovery: metadataDateRecovery(row.ledger_metadata_json),
	};
}

export function resolveLedgerDateForComposite(input: {
	occurred_at?: string | null;
	posted_at?: string | null;
	cleared_at?: string | null;
	occurredAt?: string | null;
	postedAt?: string | null;
	clearedAt?: string | null;
}) {
	const occurredAt = readInputValue(input, "occurred_at", "occurredAt");
	if (isExactLedgerDate(occurredAt)) {
		return occurredAt ?? null;
	}
	const postedAt = readInputValue(input, "posted_at", "postedAt");
	if (isExactLedgerDate(postedAt)) {
		return postedAt ?? null;
	}
	const clearedAt = readInputValue(input, "cleared_at", "clearedAt");
	return isExactLedgerDate(clearedAt) ? (clearedAt ?? null) : null;
}

export function dateRecoveryMetadata(input: {
	existing?: LedgerDateRecovery | null;
	originalOccurredAt?: string | null;
	originalPostedAt?: string | null;
	originalClearedAt?: string | null;
	recoveredField?: LedgerDateSource | null;
	recoveredFrom?: string | null;
	recoveredValue?: string | null;
	sourceMessageReceivedAt?: string | null;
	sourceRawHeaderDate?: string | null;
	note?: string | null;
}) {
	const originalPeriod = ["month", "year"].includes(
		precisionForLedgerDate(input.originalOccurredAt),
	)
		? (input.originalOccurredAt ?? null)
		: null;
	const payload = pruneNullish({
		...(input.existing ?? {}),
		recoveredField: input.recoveredField ?? null,
		recoveredFrom: input.recoveredFrom ?? null,
		recoveredValue: input.recoveredValue ?? null,
		recoveredBeancountDate: toBeancountDate(input.recoveredValue),
		originalOccurredAt: input.originalOccurredAt ?? null,
		originalOccurredAtPrecision: precisionForLedgerDate(
			input.originalOccurredAt,
		),
		originalPostedAt: input.originalPostedAt ?? null,
		originalPostedAtPrecision: precisionForLedgerDate(input.originalPostedAt),
		originalClearedAt: input.originalClearedAt ?? null,
		originalClearedAtPrecision: precisionForLedgerDate(input.originalClearedAt),
		originalPeriod,
		sourceMessageReceivedAt: input.sourceMessageReceivedAt ?? null,
		sourceRawHeaderDate: input.sourceRawHeaderDate ?? null,
		note: input.note ?? null,
	});
	return Object.keys(payload).length > 0 ? payload : null;
}
